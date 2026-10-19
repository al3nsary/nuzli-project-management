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
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

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
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_CONVERTED_BYTES) throw new AppError('MPP_CONVERSION_FAILED', { reason: 'too large' });
  const xml = buf.toString('utf8').replace(/^﻿/, '');
  if (!xml.trimStart().startsWith('<')) throw new AppError('MPP_CONVERSION_FAILED', { reason: 'not xml' });
  return xml;
}
