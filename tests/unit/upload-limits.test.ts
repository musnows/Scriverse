import { describe, expect, it } from "vitest";
import {
  AI_CHAT_IMAGE_MAX_BYTES_ENV,
  ATTACHMENT_IMAGE_MAX_BYTES_ENV,
  AVATAR_IMAGE_MAX_BYTES_ENV,
  COVER_IMAGE_MAX_BYTES_ENV,
  DEFAULT_AI_CHAT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_UPLOAD_LIMITS,
  formatUploadLimit,
  MIN_AI_CHAT_IMAGE_MAX_BYTES,
  resolveImageUploadLimits
} from "../../src/upload-limits.js";

describe("图片上传大小限制", () => {
  it("使用头像 2 MiB、封面 5 MiB、聊天图片 5 MiB 和其他附件 30 MiB 默认值", () => {
    expect(resolveImageUploadLimits({})).toEqual(DEFAULT_IMAGE_UPLOAD_LIMITS);
  });

  it("从环境变量读取字节数配置", () => {
    expect(resolveImageUploadLimits({
      [AVATAR_IMAGE_MAX_BYTES_ENV]: " 1024 ",
      [COVER_IMAGE_MAX_BYTES_ENV]: "2048",
      [ATTACHMENT_IMAGE_MAX_BYTES_ENV]: "4096",
      [AI_CHAT_IMAGE_MAX_BYTES_ENV]: String(MIN_AI_CHAT_IMAGE_MAX_BYTES)
    })).toEqual({
      avatarBytes: 1024,
      coverBytes: 2048,
      attachmentBytes: 4096,
      chatImageBytes: MIN_AI_CHAT_IMAGE_MAX_BYTES
    });
  });

  it("对非法配置回退默认值并限制最大值", () => {
    expect(resolveImageUploadLimits({
      [AVATAR_IMAGE_MAX_BYTES_ENV]: "0",
      [COVER_IMAGE_MAX_BYTES_ENV]: "1.5",
      [ATTACHMENT_IMAGE_MAX_BYTES_ENV]: "2147483648",
      [AI_CHAT_IMAGE_MAX_BYTES_ENV]: String(MIN_AI_CHAT_IMAGE_MAX_BYTES - 1)
    })).toEqual({
      avatarBytes: DEFAULT_IMAGE_UPLOAD_LIMITS.avatarBytes,
      coverBytes: DEFAULT_IMAGE_UPLOAD_LIMITS.coverBytes,
      attachmentBytes: 1_073_741_824,
      chatImageBytes: DEFAULT_AI_CHAT_IMAGE_MAX_BYTES
    });
  });

  it("按字节和 MiB 选择清晰的提示单位", () => {
    expect(formatUploadLimit(100)).toBe("100 B");
    expect(formatUploadLimit(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatUploadLimit(1.5 * 1024 * 1024)).toBe("1.50 MB");
  });
});
