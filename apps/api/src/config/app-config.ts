import type { Env } from './env.schema';

/**
 * DI token for the validated environment. Inject `AppConfig` and read typed fields.
 * (Class + interface merge: the class is the token, the interface gives the fields.)
 */
export abstract class AppConfig {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface AppConfig extends Env {}
