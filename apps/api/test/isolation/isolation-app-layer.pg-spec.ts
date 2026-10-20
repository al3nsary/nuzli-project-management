/** A12 isolation suite — the application scoping layer ALONE (superuser session: RLS bypassed). */
import { defineIsolationSuite } from './isolation-suite';

jest.setTimeout(600_000);
defineIsolationSuite({ rls: false });
