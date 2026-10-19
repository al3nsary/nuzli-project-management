/**
 * A9 — client of the internal `converter` service (infra/converter, MPXJ): POST the .mpp bytes
 * to `${CONVERTER_URL}/convert` with `X-Converter-Token`, receive MSPDI XML. Internal network
 * only; size-capped, time-limited. Without CONVERTER_URL the API answers
 * 501 MPP_CONVERTER_NOT_CONFIGURED (the message tells the admin to save as XML in MS Project).
 */
import { AppError } from '../common/app-error';

export const CONVERTER_TOKEN_HEADER = 'X-Converter-Token';
/** Largest MSPDI accepted back from the converter. */
export const MAX_CONVERTED_BYTES = 60 * 1024 * 1024;

export interface ConverterConfig {
  url?: string;
  token?: string;
  timeoutMs: number;
  /** Cap of the XML read back (default MAX_CONVERTED_BYTES). */
  maxBytes?: number;
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  /** The response body as a stream (fetch); read chunk by chunk under the size cap. */
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Reads a response under a byte cap (security review A9 "to verify"): the stream is cancelled as
 * soon as the cap is passed, so a misbehaving converter cannot make the API buffer an unbounded body.
 */
export async function readCapped(res: { body?: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> }, max: number): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new AppError('MPP_CONVERSION_FAILED', { reason: 'too large' });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('MPP_CONVERSION_FAILED', { reason: 'too large' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function convertMpp(bytes: Uint8Array, cfg: ConverterConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  if (!cfg.url) throw new AppError('MPP_CONVERTER_NOT_CONFIGURED');
  const url = `${cfg.url.replace(/\/+$/, '')}/convert`;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.ms-project',
        Accept: 'application/xml',
        ...(cfg.token ? { [CONVERTER_TOKEN_HEADER]: cfg.token } : {}),
      },
      body: bytes,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch {
    throw new AppError('MPP_CONVERSION_FAILED', { reason: 'unreachable' });
  }
  if (res.status === 422 || res.status === 400) throw new AppError('IMPORT_FILE_INVALID', { reason: 'mpp' });
  if (!res.ok) throw new AppError('MPP_CONVERSION_FAILED', { status: res.status });
  let buf: Buffer;
  try {
    buf = await readCapped(res, cfg.maxBytes ?? MAX_CONVERTED_BYTES);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('MPP_CONVERSION_FAILED', { reason: 'unreachable' });
  }
  const xml = buf.toString('utf8').replace(/^﻿/, '');
  if (!xml.trimStart().startsWith('<')) throw new AppError('MPP_CONVERSION_FAILED', { reason: 'not xml' });
  return xml;
}
