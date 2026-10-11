import { PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodTypeAny, z } from 'zod';
import { AppError } from './app-error';

/** zod issues → `{ fieldErrors: { "path.to.field": ["Arabic message"] } }`. */
export function toFieldErrors(issues: ZodIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length ? issue.path.join('.') : '_root';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new AppError('VALIDATION_FAILED', { fieldErrors: toFieldErrors(result.error.issues) });
    }
    return result.data;
  }
}
