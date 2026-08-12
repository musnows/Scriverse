import { describe, expect, it } from "vitest";
import { normalizeUploadProgress, uploadProgressText } from "../../src/public/upload-progress.js";

describe("图片上传进度", () => {
  it("将进度限制在 0 到 100 并取整", () => {
    expect(normalizeUploadProgress(-4)).toBe(0);
    expect(normalizeUploadProgress(48.6)).toBe(49);
    expect(normalizeUploadProgress(140)).toBe(100);
  });

  it("对未知长度上传显示无百分比文案", () => {
    expect(normalizeUploadProgress(undefined)).toBeNull();
    expect(uploadProgressText(undefined)).toBe("正在上传");
    expect(uploadProgressText(72)).toBe("上传中 72%");
  });
});
