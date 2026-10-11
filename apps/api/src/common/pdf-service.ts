/**
 * The optional PDF renderer (ADR-024/043) runs on the internal `backend` network only and
 * accepts requests that carry PDF_SERVICE_TOKEN in this header (security review, ADR-064).
 * Card batches may include full national IDs, so the service must never be reachable from
 * the edge network and must reject calls without the token.
 */
export const PDF_TOKEN_HEADER = 'X-Pdf-Service-Token';

/** Request headers for the PDF service: JSON in, PDF out, shared-secret token. */
export function pdfServiceHeaders(token: string | undefined): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/pdf',
    ...(token ? { [PDF_TOKEN_HEADER]: token } : {}),
  };
}
