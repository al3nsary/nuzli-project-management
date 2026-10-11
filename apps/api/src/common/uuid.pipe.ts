import { PipeTransform } from '@nestjs/common';
import { AppError } from './app-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route id that is not a UUID can never exist → 404 (and never reaches Postgres). */
export class UuidPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw new AppError('NOT_FOUND');
    return value.toLowerCase();
  }
}
