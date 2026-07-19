import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("作品工作台按需加载", () => {
  it("打开作品时只加载目录和当前章节", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const selectWorkSource = application.slice(
      application.indexOf("async function selectWork(workId, preferredChapterId = null)"),
      application.indexOf("function renderTree()")
    );

    expect(selectWorkSource).toContain("renderTree();");
    expect(selectWorkSource).toContain("await selectChapter(targetChapter.id)");
    expect(selectWorkSource).toContain("chapter.id === preferredChapterId");
    expect(selectWorkSource).not.toContain("await loadModels()");
    expect(selectWorkSource).not.toContain("await loadAiReferences()");
    expect(selectWorkSource).not.toContain("await loadAiConversations()");
  });

  it("子模块和创作助手资源只在首次使用时加载", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const showModuleSource = application.slice(
      application.indexOf("async function showModule(module)"),
      application.indexOf("function emptyModule(")
    );

    expect(showModuleSource).toContain('if (module === "settings") await renderSettings()');
    expect(showModuleSource).toContain('if (module === "characters") await renderCharacters()');
    expect(showModuleSource).toContain('if (module === "timeline") await renderTimeline()');
    expect(showModuleSource).toContain('if (module === "relationships") await renderRelationships()');
    expect(application).toContain('$("#ai-prompt").addEventListener("focus"');
    expect(application).toContain("await ensureAiReferencesLoaded();");
    expect(application).toContain("await ensureAiConversationsLoaded();");
  });
});
