export const AI_CHAT_IMAGE_ATTACHMENT_MAX_COUNT: number;

export function isAiChatImageFile(file: { type?: string } | null | undefined): boolean;
export function aiChatImageAttachmentUrl(attachmentId: string): string;
export function normalizeAiChatImageAttachment(value: unknown): {
  id: string;
  originalName: string;
  storedMimeType: string;
  width: number;
  height: number;
  contentUrl: string;
} | null;
export function normalizeAiChatImageAttachments(value: unknown): Array<{
  id: string;
  originalName: string;
  storedMimeType: string;
  width: number;
  height: number;
  contentUrl: string;
}>;
export function aiChatImageAttachmentIds(value: unknown): string[];
