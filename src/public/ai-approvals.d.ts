export type AiApprovalChange = {
  field?: unknown;
  label?: unknown;
  before?: unknown;
  after?: unknown;
};

export type AiApprovalOperation = {
  operationType?: unknown;
  moduleLabel?: unknown;
  aiSummary?: unknown;
  targetId?: unknown;
  targetLabel?: unknown;
  targetVersionNo?: unknown;
  referencedText?: unknown;
  changes?: AiApprovalChange[];
  result?: unknown;
  failure?: unknown;
  [key: string]: unknown;
};

export function aiApprovalStatusLabel(status: unknown): string;

export function aiApprovalStatusTone(status: unknown): string;

export function aiWriteOperationLabel(operationType: unknown): string;

export function aiApprovalStatusOptions(selected: unknown): string;

export function aiApprovalStatusSummary(status: unknown, plan: { invalidationReason?: unknown; revokedAt?: unknown; expiresAt?: unknown }): string;

export function formatApprovalDateTimeForDisplay(value: unknown): string;

export function aiApprovalOperationChangesHtml(operation: AiApprovalOperation): string;

export function aiApprovalOperationHtml(operation: AiApprovalOperation, index: number): string;
