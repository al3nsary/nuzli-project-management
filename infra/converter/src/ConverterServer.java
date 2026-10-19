import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.sf.mpxj.ProjectFile;
import net.sf.mpxj.mspdi.MSPDIWriter;
import net.sf.mpxj.reader.UniversalProjectReader;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Nuzli converter (owner request A9, ADR-111): MS Project .mpp → MSPDI XML with MPXJ.
 *
 *   POST /convert   body = the .mpp bytes, header X-Converter-Token = CONVERTER_TOKEN
 *                   → 200 application/xml (MSPDI) | 401 | 405 | 413 | 415 | 422 | 504
 *   GET  /health    → 200 "ok"
 *
 * Internal network only (docker compose `backend`), never published. Every request needs the
 * shared token (constant-time comparison); bodies are capped (CONVERTER_MAX_BYTES, default
 * 20 MB) and each conversion is time-limited (CONVERTER_TIMEOUT_SECONDS, default 50). Only OLE2
 * compound files (.mpp) are accepted. Nothing is written to disk and nothing is logged about
 * the file's content.
 */
public final class ConverterServer {
  private static final byte[] OLE2 = {(byte) 0xD0, (byte) 0xCF, 0x11, (byte) 0xE0, (byte) 0xA1, (byte) 0xB1, 0x1A, (byte) 0xE1};

  private static byte[] token;
  private static long maxBytes;
  private static int timeoutSeconds;
  private static ExecutorService workers;

  public static void main(String[] args) throws IOException {
    String t = System.getenv("CONVERTER_TOKEN");
    if (t == null || t.length() < 32 || t.contains("CHANGE_ME")) {
      System.err.println("CONVERTER_TOKEN must be set (at least 32 characters, e.g. openssl rand -base64 48)");
      System.exit(1);
    }
    token = t.getBytes(StandardCharsets.UTF_8);
    maxBytes = envLong("CONVERTER_MAX_BYTES", 20L * 1024 * 1024);
    timeoutSeconds = (int) envLong("CONVERTER_TIMEOUT_SECONDS", 50);
    int port = (int) envLong("PORT", 8080);
    int concurrency = (int) Math.max(1, Math.min(4, envLong("CONVERTER_CONCURRENCY", 2)));

    workers = Executors.newFixedThreadPool(concurrency);
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 32);
    server.setExecutor(Executors.newFixedThreadPool(concurrency + 2));
    server.createContext("/health", ex -> send(ex, 200, "text/plain; charset=utf-8", "ok".getBytes(StandardCharsets.UTF_8)));
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

  private static void convert(HttpExchange ex) throws IOException {
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
      byte[] body = readCapped(ex.getRequestBody());
      if (body == null) {
        text(ex, 413, "too large");
        return;
      }
      if (body.length < OLE2.length || !startsWith(body, OLE2)) {
        text(ex, 415, "not an .mpp file");
        return;
      }
      Future<byte[]> job = workers.submit(() -> {
        ProjectFile project = new UniversalProjectReader().read(new ByteArrayInputStream(body));
        if (project == null) return null;
        ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
        new MSPDIWriter().write(project, out);
        return out.toByteArray();
      });
      byte[] xml;
      try {
        xml = job.get(timeoutSeconds, TimeUnit.SECONDS);
      } catch (TimeoutException e) {
        job.cancel(true);
        text(ex, 504, "timeout");
        return;
      } catch (Exception e) {
        text(ex, 422, "unreadable project file");
        return;
      }
      if (xml == null) {
        text(ex, 422, "unreadable project file");
        return;
      }
      send(ex, 200, "application/xml; charset=utf-8", xml);
    } catch (IOException e) {
      text(ex, 400, "bad request");
    } finally {
      ex.close();
    }
  }

  private static byte[] readCapped(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[64 * 1024];
    long total = 0;
    int n;
    while ((n = in.read(buf)) > 0) {
      total += n;
      if (total > maxBytes) return null;
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
