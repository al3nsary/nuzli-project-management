import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { can } from '@nuzli/shared';
import { map } from 'rxjs';
import { AppError } from '../common/app-error';
import type { AuthRequest } from '../common/request';

/** Every money field of the project/task DTOs (ProjectDto, TaskDto, budget, dashboard, people, reports). */
export const BUDGET_KEYS: ReadonlySet<string> = new Set([
  'budget',
  'plannedCost',
  'actualCost',
  'costVariance',
  'budgetVariance',
  'budgetUsedPct',
  'overBudget',
  'overBudgetTasks',
  'budgetShare',
  'budgetBurn',
]);

/** Request fields that change money (project budget, task costs). */
const BUDGET_WRITE_KEYS = new Set(['budget', 'plannedCost', 'actualCost']);
const PROJECT_ROUTES = /\/(projects|tasks|project-templates|portfolios|reports|hub|attachments)(\/|$)/;

/** Removes the money fields from a JSON value (deep, in place on a copy-free walk). */
export function stripBudget<T>(value: T, depth = 0): T {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const v of value) stripBudget(v, depth + 1);
    return value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (BUDGET_KEYS.has(key)) delete (value as Record<string, unknown>)[key];
    else stripBudget((value as Record<string, unknown>)[key], depth + 1);
  }
  return value;
}

export function bodyChangesBudget(body: unknown, depth = 0): boolean {
  if (depth > 6 || body === null || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.some((v) => bodyChangesBudget(v, depth + 1));
  return Object.entries(body as Record<string, unknown>).some(
    ([k, v]) => (BUDGET_WRITE_KEYS.has(k) && v !== undefined) || bodyChangesBudget(v, depth + 1),
  );
}

/**
 * A12 round 2 (owner rule): the budget is for admins, owners and assistants with budget:view.
 * Everyone else — supervisors, monitors, project participants, assistants without the module —
 * gets project and task data WITHOUT any money field, and a request that would change money
 * (project budget, task planned/actual cost) needs `budget.manage` (403 otherwise).
 * One place for every route, so a new endpoint cannot leak a figure by forgetting a check.
 */
@Injectable()
export class BudgetInterceptor implements NestInterceptor {
  // Typed loosely: the workspace has two rxjs copies (root and apps/api); the operator works on both.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intercept(context: ExecutionContext, next: CallHandler): any {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<AuthRequest & { route?: { path?: string } }>();
    const user = req.user;
    if (!user || !user.workspaceId) return next.handle();
    const path = req.route?.path ?? req.path ?? '';
    if (!PROJECT_ROUTES.test(path)) return next.handle();
    if (req.method !== 'GET' && !can(user, 'budget.manage') && bodyChangesBudget(req.body)) {
      throw new AppError('FORBIDDEN', { field: 'budget', reason: 'budget.manage' });
    }
    if (can(user, 'budget.read')) return next.handle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (next.handle() as any).pipe(map((data: unknown) => (Buffer.isBuffer(data) ? data : stripBudget(data))));
  }
}
