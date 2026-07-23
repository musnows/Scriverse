import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function collectJavaScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectJavaScriptFiles(path) : entry.name.endsWith(".js") ? [path] : [];
  }));
  return files.flat().sort();
}

describe("前端脚本", () => {
  it("所有公开 JavaScript 文件都保持可解析", async () => {
    const files = await collectJavaScriptFiles(join(process.cwd(), "src/public"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await expect(execFileAsync(process.execPath, ["--check", file])).resolves.toBeDefined();
    }
  });
});
