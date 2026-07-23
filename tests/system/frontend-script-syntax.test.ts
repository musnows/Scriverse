import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("前端脚本", () => {
  it("保持可被 JavaScript 运行时解析", async () => {
    await expect(execFileAsync(process.execPath, ["--check", "src/public/app.js"])).resolves.toBeDefined();
  });
});
