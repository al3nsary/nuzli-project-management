/** A12 isolation suite — application scoping layer + PostgreSQL RLS (the API's role, nuzli_app). */
import { defineIsolationSuite } from './isolation-suite';

jest.setTimeout(600_000);
defineIsolationSuite({ rls: true });
