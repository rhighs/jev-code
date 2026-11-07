import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult, type TypeSafeClientConfig } from '@typesafe-ai/sdk';
import type { DecisionProvider } from './types.js';

/**
 * Thin DecisionProvider over the TypeSafe SDK. Configuration is passed explicitly so the caller
 * decides the credentialed destination; the SDK's environment fallback remains available for a
 * standalone SDK user, and `TYPESAFE_BASE_URL` from a project `.env` never reaches this process's
 * environment (see loadProjectEnv).
 */
export class JevProvider implements DecisionProvider {
  private readonly client: TypeSafeClient;

  constructor(config: TypeSafeClientConfig = {}) {
    this.client = new TypeSafeClient({ ...config, timeout: config.timeout ?? 30_000 });
  }

  async decide<Q extends Questions>(state: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    return this.client.systemOne({ state, questions }, signal ? { signal } : {});
  }
}
