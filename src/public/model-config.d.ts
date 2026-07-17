export const MODEL_PURPOSE_OPTIONS: ReadonlyArray<readonly [string, string]>;

export type ModelFormValues = {
  displayName: string;
  modelId: string;
  purposes: string[];
  contextWindow: number;
  temperature: number;
  maxTokens: number;
  thinkingEnabled: boolean;
  enabled: boolean;
};

export function normalizeModelPurposes(purposes: unknown): string[];
export function modelFormValues(model?: Record<string, unknown> | null): ModelFormValues;
export function modelPayload(values: ModelFormValues, existingPreset?: Record<string, unknown>): Record<string, unknown> & { thinkingEnabled: boolean };
export function modelOptionLabel(model: Record<string, unknown> | null | undefined): string;
