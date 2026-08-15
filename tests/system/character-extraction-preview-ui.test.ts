import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("角色抽取结果入库预览界面", () => {
  it("在任务详情中加载、勾选、编辑并确认角色候选", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('/styles.css?v=20260815-ai-context-preview-v1');
    expect(page).toContain('/app.js?v=20260815-ai-context-preview-v1');
    expect(application).toContain("function renderCharacterExtractionPreview(task, result)");
    expect(application).toContain("function renderCharacterExtractionEditor(preview)");
    expect(application).toContain("function bindCharacterExtractionEditor(container, taskId)");
    expect(application).toContain('data-load-character-extraction-preview="${esc(task.id)}"');
    expect(application).toContain("/character-extraction/preview");
    expect(application).toContain("/character-extraction/apply");
    expect(application).toContain("角色库尚未修改");
    expect(application).toContain("合并只追加无冲突别名、空缺身份、种族和首次登场");
    expect(application).toContain('data-character-extraction-selected');
    expect(application).toContain('data-character-extraction-action');
    expect(application).toContain('data-character-extraction-target');
    expect(application).toContain('role="alert"');
    expect(application).toContain("重复点击或网络重试不会重复创建");
    expect(styles).toContain(".character-extraction-preview.is-pending");
    expect(styles).toContain(".character-extraction-candidate > header");
    expect(styles).toContain(".character-extraction-fields");
    expect(styles).toContain(".character-extraction-apply-error");
    expect(styles).toContain(".character-extraction-fields .character-extraction-wide-field { grid-column: 1;");
  });
});
