import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/*
 * URL-driven UI state (navigation rule 5): drawers, tabs and wizard steps live in the query
 * string, so they are deep-linkable, survive a reload, and the browser's back button closes a
 * drawer or returns to the previous step instead of leaving the page. Changing only the query
 * string never resets the scroll position (`preventScrollReset`), and the page lifecycle in
 * Layout only treats a change of *path* as a new page.
 */

type NavState = Record<string, unknown> | null;

function withParam(search: string, name: string, value: string | null, drop: string[] = []): string {
  const next = new URLSearchParams(search);
  if (value === null) next.delete(name);
  else next.set(name, value);
  for (const d of drop) next.delete(d);
  const s = next.toString();
  return s ? `?${s}` : '';
}

/**
 * A drawer or dialog bound to `?name=value`. Opening pushes a history entry (so back closes
 * it); switching to another item replaces it; closing goes back when we pushed the entry, or
 * removes the parameter in place when the page was opened from a deep link.
 */
export function useOverlayParam(name: string, opts: { drop?: string[] } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const value = new URLSearchParams(location.search).get(name);
  const state = (location.state as NavState) ?? null;
  const pushed = state?.nzOverlay === name;
  const drop = opts.drop ?? [];

  const open = useCallback(
    (v: string) => {
      navigate(
        { pathname: location.pathname, search: withParam(location.search, name, v, drop) },
        { replace: pushed, state: { ...(state ?? {}), nzOverlay: name }, preventScrollReset: true },
      );
    },
    [navigate, location.pathname, location.search, name, pushed, state, drop.join(',')], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const close = useCallback(() => {
    if (pushed) {
      navigate(-1);
      return;
    }
    const rest = { ...(state ?? {}) };
    delete rest.nzOverlay;
    navigate(
      { pathname: location.pathname, search: withParam(location.search, name, null, drop) },
      { replace: true, state: rest, preventScrollReset: true },
    );
  }, [navigate, location.pathname, location.search, name, pushed, state, drop.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return { value, open, close };
}

/** A tab bound to `?name=` (replace: switching tabs is not a history step). */
export function useTabParam<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (v: string | null) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = new URLSearchParams(location.search).get(name);
  const value = (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const set = useCallback(
    (v: string | null) => {
      const next = !v || v === fallback ? null : v;
      navigate(
        { pathname: location.pathname, search: withParam(location.search, name, next) },
        { replace: true, state: location.state, preventScrollReset: true },
      );
    },
    [navigate, location.pathname, location.search, location.state, name, fallback],
  );
  return [value, set];
}

/**
 * A wizard step bound to `?name=` (1-based in the URL). Forward pushes a history entry, so the
 * browser's back button returns to the previous step; `reset` goes back to the first step in place.
 */
export function useStepParam(name: string, count: number) {
  const location = useLocation();
  const navigate = useNavigate();
  const raw = Number(new URLSearchParams(location.search).get(name));
  const step = Number.isInteger(raw) && raw >= 1 && raw <= count ? raw - 1 : 0;
  const state = (location.state as NavState) ?? null;

  const go = useCallback(
    (to: number, mode: 'push' | 'replace' = 'push') => {
      const clamped = Math.max(0, Math.min(count - 1, to));
      navigate(
        { pathname: location.pathname, search: withParam(location.search, name, clamped === 0 ? null : String(clamped + 1)) },
        { replace: mode === 'replace', state: { ...(state ?? {}), nzStep: clamped }, preventScrollReset: true },
      );
    },
    [navigate, location.pathname, location.search, name, count, state],
  );

  /** Back one step: the browser entry when we pushed it, otherwise in place. */
  const back = useCallback(() => {
    if (step === 0) return;
    if (typeof state?.nzStep === 'number' && state.nzStep === step) navigate(-1);
    else go(step - 1, 'replace');
  }, [step, state, navigate, go]);

  return { step, next: () => go(step + 1), back, go, reset: () => go(0, 'replace') };
}
