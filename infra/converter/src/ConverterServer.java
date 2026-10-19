import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.sf.mpxj.ProjectFile;
import net.sf.mpxj.mspdi.MSPDIWriter;
import net.sf.mpxj.reader.UniversalProjectReader;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Nuzli converter (owner request A9, ADR-111): MS Project .mpp → MSPDI XML with MPXJ.
 *
 *   POST /convert   body = the .mpp bytes, header X-Converter-Token = CONVERTER_TOKEN
 *                   → 200 application/xml (MSPDI) | 401 | 405 | 413 | 415 | 422 | 503 | 504
 *   GET  /health    → 200 "ok"
 *
 * Internal network only (docker compose `converter`, internal: true — no egress), never
 * published. Every request needs the shared token (constant-time comparison); bodies are capped
 * (CONVERTER_MAX_BYTES, default 20 MB). Only OLE2 compound files (.mpp) are accepted. Nothing is
 * written to disk and nothing is logged about the file's content.
 *
 * Security review A9 L6 (ADR-120): MPXJ does not check for interrupts, so a pathological file
 * could keep a worker thread forever. Each conversion therefore runs in its own child JVM
 * (`ConverterServer --convert`, stdin → stdout) with its own heap (CONVERTER_CHILD_HEAP, default
 * 256m). The parent kills the child (destroyForcibly) when CONVERTER_TIMEOUT_SECONDS (default 50)
 * pass, so a stuck conversion never holds a slot. At most CONVERTER_CONCURRENCY (1–4) children
 * run at once; a request that cannot get a slot within the timeout gets 503. The XML read back
 * from the child is capped (CONVERTER_MAX_OUTPUT_BYTES, default 60 MB).
 */
public final class ConverterServer {
  private static final byte[] OLE2 = {(byte) 0xD0, (byte) 0xCF, 0x11, (byte) 0xE0, (byte) 0xA1, (byte) 0xB1, 0x1A, (byte) 0xE1};

  /** Exit codes of the child process. */
  private static final int EXIT_UNREADABLE = 3;
  private static final int EXIT_FAILED = 4;

  private static byte[] token;
  private static long maxBytes;
  private static long maxOutputBytes;
  private static int timeoutSeconds;
  private static String childHeap;
  private static Semaphore slots;
  /** Pipe pumps (stdin writer, stdout reader) of the children; never the ForkJoin common pool. */
  private static final ExecutorService PUMPS = Executors.newCachedThreadPool(r -> {
    Thread t = new Thread(r, "converter-pump");
    t.setDaemon(true);
    return t;
  });

  public static void main(String[] args) throws IOException {
    if (args.length > 0 && "--convert".equals(args[0])) {
      System.exit(convertChild());
      return;
    }
    String t = System.getenv("CONVERTER_TOKEN");
    if (t == null || t.length() < 32 || t.contains("CHANGE_ME")) {
      System.err.println("CONVERTER_TOKEN must be set (at least 32 characters, e.g. openssl rand -base64 48)");
      System.exit(1);
    }
    token = t.getBytes(StandardCharsets.UTF_8);
    maxBytes = envLong("CONVERTER_MAX_BYTES", 20L * 1024 * 1024);
    maxOutputBytes = envLong("CONVERTER_MAX_OUTPUT_BYTES", 60L * 1024 * 1024);
    timeoutSeconds = (int) Math.max(1, envLong("CONVERTER_TIMEOUT_SECONDS", 50));
    String heap = System.getenv("CONVERTER_CHILD_HEAP");
    childHeap = heap == null || !heap.matches("\\d{2,5}[mMgG]") ? "256m" : heap;
    int port = (int) envLong("PORT", 8080);
    int concurrency = (int) Math.max(1, Math.min(4, envLong("CONVERTER_CONCURRENCY", 2)));

    slots = new Semaphore(concurrency, true);
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 32);
    server.setExecutor(Executors.newFixedThreadPool(concurrency + 2));
    server.createContext("/health", ex -> {
      try {
        send(ex, 200, "text/plain; charset=utf-8", "ok".getBytes(StandardCharsets.UTF_8));
      } finally {
        ex.close();
      }
    });
    server.createContext("/convert", ConverterServer::convert);
    server.start();
    System.out.println("converter listening on " + port);
  }

  private static long envLong(String name, long def) {
    String v = System.getenv(name);
    if (v == null || v.isBlank()) return def;
    try {
      return Long.parseLong(v.trim());
    } catch (NumberFormatException e) {
      return def;
    }
  }

  // ─────────────────────────────────────────── child process: stdin (.mpp) → stdout (MSPDI)

  private static int convertChild() {
    try {
      byte[] body = System.in.readAllBytes();
      ProjectFile project = new UniversalProjectReader().read(new ByteArrayInputStream(body));
      if (project == null) return EXIT_UNREADABLE;
      OutputStream out = new BufferedOutputStream(System.out, 1 << 16);
      new MSPDIWriter().write(project, out);
      out.flush();
      return 0;
    } catch (Throwable e) {
      // No message: it could carry file content. The parent maps this to 422.
      return EXIT_FAILED;
    }
  }

  /** `java -Xmx<heap> -cp <this classpath> ConverterServer --convert` (same JRE as the parent). */
  private static List<String> childCommand() {
    Path java = Paths.get(System.getProperty("java.home"), "bin", "java");
    List<String> cmd = new ArrayList<>();
    cmd.add(java.toString());
    cmd.add("-Xmx" + childHeap);
    cmd.add("-XX:+ExitOnOutOfMemoryError");
    cmd.add("-XX:TieredStopAtLevel=1");
    cmd.add("-Djava.awt.headless=true");
    cmd.add("-cp");
    cmd.add(System.getProperty("java.class.path"));
    cmd.add("ConverterServer");
    cmd.add("--convert");
    return cmd;
  }

  private enum Outcome { OK, UNREADABLE, TIMEOUT, TOO_LARGE }

  private record Result(Outcome outcome, byte[] xml) {}

  /** Runs one conversion in a child JVM that is killed at the deadline. */
  private static Result runChild(byte[] body, long deadlineNanos) throws IOException, InterruptedException {
    ProcessBuilder pb = new ProcessBuilder(childCommand());
    pb.redirectError(ProcessBuilder.Redirect.DISCARD);
    // The child inherits the environment minus the token: it never needs it.
    pb.environment().remove("CONVERTER_TOKEN");
    Process p = pb.start();
    try {
      AtomicBoolean tooLarge = new AtomicBoolean(false);
      CompletableFuture<Void> writer = CompletableFuture.runAsync(() -> {
        try (OutputStream in = p.getOutputStream()) {
          in.write(body);
        } catch (IOException ignored) {
          // The child died early; its exit code tells what happened.
        }
      }, PUMPS);
      CompletableFuture<byte[]> reader = CompletableFuture.supplyAsync(() -> {
        try (InputStream out = p.getInputStream()) {
          byte[] xml = readCapped(out, maxOutputBytes);
          if (xml == null) {
            // Output above the cap: stop the child instead of letting it block on a full pipe.
            tooLarge.set(true);
            p.destroyForcibly();
          }
          return xml;
        } catch (IOException e) {
          return null;
        }
      }, PUMPS);
      long left = deadlineNanos - System.nanoTime();
      boolean finished = left > 0 && p.waitFor(left, TimeUnit.NANOSECONDS);
      if (!finished) {
        p.destroyForcibly();
        return new Result(Outcome.TIMEOUT, null);
      }
      writer.join();
      byte[] xml;
      try {
        xml = reader.get(Math.max(1, (deadlineNanos - System.nanoTime()) / 1_000_000), TimeUnit.MILLISECONDS);
      } catch (Exception e) {
        return new Result(Outcome.TIMEOUT, null);
      }
      if (tooLarge.get()) return new Result(Outcome.TOO_LARGE, null);
      if (p.exitValue() != 0 || xml == null) return new Result(Outcome.UNREADABLE, null);
      return new Result(Outcome.OK, xml);
    } finally {
      if (p.isAlive()) p.destroyForcibly();
    }
  }

  // ─────────────────────────────────────────── HTTP

  private static void convert(HttpExchange ex) throws IOException {
    boolean acquired = false;
    try {
      if (!"POST".equals(ex.getRequestMethod())) {
        text(ex, 405, "method not allowed");
        return;
      }
      String given = ex.getRequestHeaders().getFirst("X-Converter-Token");
      if (given == null || !MessageDigest.isEqual(token, given.getBytes(StandardCharsets.UTF_8))) {
        text(ex, 401, "unauthorized");
        return;
      }
      byte[] body = readCapped(ex.getRequestBody(), maxBytes);
      if (body == null) {
        text(ex, 413, "too large");
        return;
      }
      if (body.length < OLE2.length || !startsWith(body, OLE2)) {
        text(ex, 415, "not an .mpp file");
        return;
      }
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
      acquired = slots.tryAcquire(timeoutSeconds, TimeUnit.SECONDS);
      if (!acquired) {
        text(ex, 503, "busy");
        return;
      }
      Result r = runChild(body, deadline);
      switch (r.outcome()) {
        case OK -> send(ex, 200, "application/xml; charset=utf-8", r.xml());
        case TIMEOUT -> text(ex, 504, "timeout");
        case TOO_LARGE -> text(ex, 502, "output too large");
        default -> text(ex, 422, "unreadable project file");
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      text(ex, 503, "busy");
    } catch (IOException e) {
      text(ex, 400, "bad request");
    } finally {
      if (acquired) slots.release();
      ex.close();
    }
  }

  /** The whole stream, or null when it is longer than {@code max} bytes. */
  private static byte[] readCapped(InputStream in, long max) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[64 * 1024];
    long total = 0;
    int n;
    while ((n = in.read(buf)) > 0) {
      total += n;
      if (total > max) return null;
      out.write(buf, 0, n);
    }
    return out.toByteArray();
  }

  private static boolean startsWith(byte[] b, byte[] p) {
    for (int i = 0; i < p.length; i++) if (b[i] != p[i]) return false;
    return true;
  }

  private static void text(HttpExchange ex, int status, String msg) throws IOException {
    send(ex, status, "text/plain; charset=utf-8", msg.getBytes(StandardCharsets.UTF_8));
  }

  private static void send(HttpExchange ex, int status, String type, byte[] body) throws IOException {
    ex.getResponseHeaders().set("Content-Type", type);
    ex.getResponseHeaders().set("Cache-Control", "no-store");
    ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
    ex.sendResponseHeaders(status, body.length);
    try (OutputStream os = ex.getResponseBody()) {
      os.write(body);
    }
  }
}
