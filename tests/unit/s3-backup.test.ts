import { describe, expect, it } from "vitest";
import { computeS3Key } from "../../src/s3-backup.js";

describe("computeS3Key", () => {
  it("无子目录时返回 scriverse 前缀", () => {
    expect(computeS3Key("", "db/test.db")).toBe("scriverse/db/test.db");
  });

  it("有子目录时包含子目录路径", () => {
    expect(computeS3Key("production", "db/test.db")).toBe("production/scriverse/db/test.db");
  });

  it("去除子目录首尾斜线", () => {
    expect(computeS3Key("/production/", "db/test.db")).toBe("production/scriverse/db/test.db");
  });

  it("处理空相对路径", () => {
    expect(computeS3Key("backup", "")).toBe("backup/scriverse");
  });

  it("处理多层子目录", () => {
    expect(computeS3Key("org/project", "img/ab/file.webp")).toBe("org/project/scriverse/img/ab/file.webp");
  });

  it("避免连续斜线", () => {
    expect(computeS3Key("/app/", "/db//test.db")).toBe("app/scriverse/db/test.db");
  });
});
