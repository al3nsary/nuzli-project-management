import { isFullNationalIdTerm } from '@nuzli/shared';
import { AppError } from './app-error';

/**
 * Security review L4 (ADR-067): a full national ID never travels in a URL (query strings end up
 * in browser history, service-worker caches and intermediaries). GET list endpoints refuse a
 * 10-digit term; the client sends it in the body of `POST /members/search` / `POST /users/search`.
 * Last-4 digits and names stay on GET.
 */
export function assertNoNationalIdInQuery(q: string | undefined, searchPath: string): void {
  if (!isFullNationalIdTerm(q)) return;
  throw new AppError('VALIDATION_FAILED', {
    fieldErrors: { q: ['لحماية البيانات لا يُرسل رقم الهوية كاملًا في الرابط؛ ابحث به من خانة البحث مرة أخرى.'] },
    useInstead: `POST ${searchPath}`,
  });
}
