export const AI_CHAT_IMAGE_ATTACHMENT_MAX_COUNT = 4;

const supportedImageMimeType = /^image\/(?:png|jpe?g)$/u;

export function isAiChatImageFile(file) {
  return Boolean(file) && supportedImageMimeType.test(String(file.type ?? ""));
}

export function aiChatImageAttachmentUrl(attachmentId) {
  return `/api/attachments/${encodeURIComponent(String(attachmentId))}/content`;
}

export function normalizeAiChatImageAttachment(value) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id ?? "").trim();
  if (!id) return null;
  return {
    id,
    originalName: String(value.originalName ?? "图片附件"),
    storedMimeType: String(value.storedMimeType ?? value.mimeType ?? "image/png"),
    width: Number(value.width) || 0,
    height: Number(value.height) || 0,
    contentUrl: String(value.contentUrl ?? aiChatImageAttachmentUrl(id))
  };
}

export function normalizeAiChatImageAttachments(value) {
  const attachments = Array.isArray(value) ? value : [];
  const seen = new Set();
  return attachments
    .map(normalizeAiChatImageAttachment)
    .filter((attachment) => {
      if (!attachment || seen.has(attachment.id)) return false;
      seen.add(attachment.id);
      return true;
    })
    .slice(0, AI_CHAT_IMAGE_ATTACHMENT_MAX_COUNT);
}

export function aiChatImageAttachmentIds(value) {
  return normalizeAiChatImageAttachments(value).map((attachment) => attachment.id);
}
