import type { ApiClient } from './client';

export type { ApiClient } from './client';
export { ApiError, errorMessage } from './errors';

export const IS_DEMO = import.meta.env.VITE_DEMO === '1';

/**
 * Picks the adapter: the in-browser DemoApi for the GitHub Pages build (VITE_DEMO=1),
 * the HTTP adapter otherwise. Dynamic imports keep the demo seed out of the real build.
 */
export async function createApi(): Promise<ApiClient> {
  if (IS_DEMO) {
    const { DemoApi } = await import('./demo/DemoApi');
    return new DemoApi();
  }
  const { HttpApi } = await import('./http');
  return new HttpApi();
}
