import type { PrintRunCardDto } from '@nuzli/shared';

/**
 * The cards of the current print run (ADR-064, security review M2): the only copy of full
 * national IDs on the device. Kept in module memory only — never in storage, the URL, the
 * query cache or a log — and dropped when the print page closes, after printing, or on logout.
 */
const runs = new Map<string, PrintRunCardDto[]>();

export function putPrintRun(batchId: string, cards: PrintRunCardDto[]): void {
  runs.clear(); // one run at a time
  runs.set(batchId, cards);
}

export function getPrintRun(batchId: string): PrintRunCardDto[] | null {
  return runs.get(batchId) ?? null;
}

export function dropPrintRun(batchId?: string): void {
  if (batchId) runs.delete(batchId);
  else runs.clear();
}
