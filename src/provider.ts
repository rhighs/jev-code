import { TypeSafeClient, type EntryType, type Questions, type SystemOneResult } from '@typesafe-ai/sdk';
import type { DecisionProvider } from './types.js';

export class JevProvider implements DecisionProvider {
  constructor(private readonly client = new TypeSafeClient({ timeout: 30_000 })) {}

  async decide<Q extends Questions>(state: EntryType, questions: Q, signal?: AbortSignal): Promise<SystemOneResult<Q>> {
    return this.client.systemOne({ state, questions }, signal ? { signal } : {});
  }
}
