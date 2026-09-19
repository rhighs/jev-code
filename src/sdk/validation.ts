import type { RunResources } from './resources.js';

export type ValidationResult = boolean | string | void;

export interface ValidationContext {
  readonly signal: AbortSignal;
  readonly resources: RunResources;
}

export type Validator<Value> = (value: Value, context: ValidationContext) => ValidationResult | Promise<ValidationResult>;

export const validationDetail = async <Value>(
  value: Value,
  validator: Validator<Value> | undefined,
  context: ValidationContext,
  fallback: string,
): Promise<string | undefined> => {
  if (validator === undefined) return undefined;
  context.resources.throwIfAborted();
  const result = await validator(value, context);
  context.resources.throwIfAborted();
  return result === false ? fallback : typeof result === 'string' ? result : undefined;
};
