import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_IMAGE_MAX_BYTES_ENV,
  AVATAR_IMAGE_MAX_BYTES_ENV,
  COVER_IMAGE_MAX_BYTES_ENV,
  DEFAULT_IMAGE_UPLOAD_LIMITS,
  formatUploadLimit,
  resolveImageUploadLimits
} from "../../src/upload-limits.js";

describe("图片上传大小限制", () => {
  it("使用头像 2 MiB、封面 5 MiB 和其他附件 30 MiB 默认值", () => {
    expect(resolveImageUploadLimits({})).toEqual(DEFAULT_IMAGE_UPLOAD_LIMITS);
  });

  it("从环境变量读取字节数配置", () => {
    expect(resolveImageUploadLimits({
      [AVATAR_IMAGE_MAX_BYTES_ENV]: " 1024 ",
      [COVER_IMAGE_MAX_BYTES_ENV]: "2048",
      [ATTACHMENT_IMAGE_MAX_BYTES_ENV]: "4096"
    })).toEqual({
      avatarBytes: 1024,
      coverBytes: 2048,
      attachmentBytes: 4096
    });
  });

  it("对非法配置回退默认值并限制最大值", () => {
    expect(resolveImageUploadLimits({
      [AVATAR_IMAGE_MAX_BYTES_ENV]: "0",
      [COVER_IMAGE_MAX_BYTES_ENV]: "1.5",
      [ATTACHMENT_IMAGE_MAX_BYTES_ENV]: "2147483648"
    })).toEqual({
      avatarBytes: DEFAULT_IMAGE_UPLOAD_LIMITS.avatarBytes,
      coverBytes: DEFAULT_IMAGE_UPLOAD_LIMITS.coverBytes,
      attachmentBytes: 1_073_741_824
    });
  });

  it("按字节和 MiB 选择清晰的提示单位", () => {
    expect(formatUploadLimit(100)).toBe("100 B");
    expect(formatUploadLimit(2 * 1024 * 1024)).toBe("2 MB");
    expect(formatUploadLimit(1.5 * 1024 * 1024)).toBe("1.50 MB");
  });
});
