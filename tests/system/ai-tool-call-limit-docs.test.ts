import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Agent 工具调用限制文档", () => {
  it("说明默认上限、环境变量和超限提示", async () => {
    const document = await readFile(join(process.cwd(), "showcase", "public", "docs", "global-tool-call-limit.html"), "utf8");

    expect(document).toContain("默认上限 80");
    expect(document).toContain("服务端默认最大值为 80");
    expect(document).toContain("SCRIVERSE_MAX_AGENT_TOOL_CALL_LIMIT");
    expect(document).toContain("5–1000");
    expect(document).toContain("Agent 工具调用上限不能超过 X 次");
    expect(document).not.toContain("范围 5–48");
  });
});
