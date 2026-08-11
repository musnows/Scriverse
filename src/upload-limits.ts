const maximumConfiguredUploadBytes = 1_073_741_824;

export const AVATAR_IMAGE_MAX_BYTES_ENV = "SCRIVERSE_AVATAR_IMAGE_MAX_BYTES";
export const COVER_IMAGE_MAX_BYTES_ENV = "SCRIVERSE_COVER_IMAGE_MAX_BYTES";
export const ATTACHMENT_IMAGE_MAX_BYTES_ENV = "SCRIVERSE_ATTACHMENT_IMAGE_MAX_BYTES";

export const DEFAULT_AVATAR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_COVER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_IMAGE_MAX_BYTES = 30 * 1024 * 1024;

export type ImageUploadLimits = {
  avatarBytes: number;
  coverBytes: number;
  attachmentBytes: number;
};

export const DEFAULT_IMAGE_UPLOAD_LIMITS: ImageUploadLimits = {
  avatarBytes: DEFAULT_AVATAR_IMAGE_MAX_BYTES,
  coverBytes: DEFAULT_COVER_IMAGE_MAX_BYTES,
  attachmentBytes: DEFAULT_ATTACHMENT_IMAGE_MAX_BYTES
};

export function formatUploadLimit(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes} B`;
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(2)} MB`;
}

function resolveUploadLimit(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name]?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return fallback;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured) || configured < 1) return fallback;
  return Math.min(maximumConfiguredUploadBytes, configured);
}

export function resolveImageUploadLimits(environment: NodeJS.ProcessEnv = process.env): ImageUploadLimits {
  return {
    avatarBytes: resolveUploadLimit(environment, AVATAR_IMAGE_MAX_BYTES_ENV, DEFAULT_AVATAR_IMAGE_MAX_BYTES),
    coverBytes: resolveUploadLimit(environment, COVER_IMAGE_MAX_BYTES_ENV, DEFAULT_COVER_IMAGE_MAX_BYTES),
    attachmentBytes: resolveUploadLimit(environment, ATTACHMENT_IMAGE_MAX_BYTES_ENV, DEFAULT_ATTACHMENT_IMAGE_MAX_BYTES)
  };
}
