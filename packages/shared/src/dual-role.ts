/**
 * A12 round 3 — the «صلاحية مزدوجة» flag on the person references embedded in responses (a task's
 * assignee, a comment's author, a team's supervisors, a participant, the people of an approval…).
 *
 * The API and the demo run the SAME two steps on every JSON answer: `personRefIds` collects the ids
 * of the person refs, ONE grouped query finds which of them hold more than one live role, and
 * `applyDualRole` marks those refs `dualRole: true` (absent = false — the answer stays light).
 * Workers (team members) are not users and carry no role, so their refs (`member`, `foreman`) are
 * never touched; a stray id that is not a user simply never matches.
 */

/** Keys whose value (or each array item) is a user reference `{ id, fullName, … }`. */
export const PERSON_REF_KEYS: ReadonlySet<string> = new Set([
  'assignee',
  'author',
  'supervisor',
  'supervisors',
  'user',
  'addedBy',
  'requestedBy',
  'decidedBy',
]);

const MAX_DEPTH = 14;

type Ref = { id: string; fullName: string; dualRole?: boolean };

function isRef(v: unknown): v is Ref {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as Ref).id === 'string' &&
    typeof (v as Ref).fullName === 'string'
  );
}

function isOpaque(v: object): boolean {
  if (v instanceof Date || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return true;
  return typeof Blob !== 'undefined' && v instanceof Blob;
}

/** Visits every person ref of `value` (depth-limited, binary payloads skipped). */
function eachRef(value: unknown, visit: (ref: Ref) => void, depth = 0): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object' || isOpaque(value)) return;
  if (Array.isArray(value)) {
    for (const v of value) eachRef(v, visit, depth + 1);
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PERSON_REF_KEYS.has(key)) {
      if (isRef(v)) visit(v);
      else if (Array.isArray(v)) for (const item of v) if (isRef(item)) visit(item);
    }
    eachRef(v, visit, depth + 1);
  }
}

/** The distinct user ids referenced by `value`'s person refs. */
export function personRefIds(value: unknown): string[] {
  const ids = new Set<string>();
  eachRef(value, (r) => ids.add(r.id));
  return [...ids];
}

/**
 * Marks (in place) every person ref whose id is in `dual` with `dualRole: true`. A ref that
 * already carries `dualRole` (a full user DTO) is left as it is. Returns `value`.
 */
export function applyDualRole<T>(value: T, dual: ReadonlySet<string>): T {
  if (!dual.size) return value;
  eachRef(value, (r) => {
    if (r.dualRole === undefined && dual.has(r.id)) r.dualRole = true;
  });
  return value;
}
