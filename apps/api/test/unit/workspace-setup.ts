/**
 * A12: unit tests build services with hand-written Prisma fakes and call them directly, outside
 * any HTTP request. Code that reads the active workspace (AsyncLocalStorage) then falls back to
 * this fixed test workspace. Tests that check the fail-closed behaviour open an explicit store
 * (`workspaceStorage.run(newStore(), …)`), which takes precedence over this fallback.
 */
import { newStore, workspaceStorage } from '../../src/prisma/workspace-context';

export const UNIT_TEST_WORKSPACE_ID = '0a120000-0000-4000-8000-000000000001';

/** The isolation and PGlite suites switch the fallback off: there, a missing context must fail. */
export const unitWorkspaceFallback = { enabled: true };

const original = workspaceStorage.getStore.bind(workspaceStorage);
const fallback = () => newStore({ workspaceId: UNIT_TEST_WORKSPACE_ID, label: 'unit-test' });
workspaceStorage.getStore = () => original() ?? (unitWorkspaceFallback.enabled ? fallback() : undefined);
