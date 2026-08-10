import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("设定库实体编辑器保存体验", () => {
  it("统一显示保存状态并在成功或失败后保持编辑器打开", async () => {
    const publicPath = join(process.cwd(), "src/public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain("async function runEntityEditorSave(");
    expect(application).toContain('busyTarget.setAttribute("aria-busy", "true")');
    expect(application).toContain('button.textContent = "保存中…"');
    expect(application).toContain('toast("正在保存…")');
    expect(application).toContain('toast(error instanceof Error ? error.message : "保存失败，请重试", "error")');
    expect(application).toContain('busyTarget.removeAttribute("aria-busy")');
    expect(application.match(/await runEntityEditorSave\(\{/gu)).toHaveLength(5);
    expect(application).toContain("function isEntityEditorSaving()");
    expect(application.match(/toast\("正在保存，请稍候"\)/gu)).toHaveLength(3);
    expect(page).toContain('/app.js?v=20260811-analysis-task-mention-presence-backup-v1');

    const settingSave = sourceBetween(application, '$("#setting-editor-form").onsubmit', 'showEntityEditorPage("setting"');
    expect(settingSave).toContain("settingEditorItem = saved");
    expect(settingSave).toContain("replacePageRoute(currentPageRoute())");
    expect(settingSave).not.toContain("closeEntityEditor");
    expect(settingSave).not.toContain("loadAiReferences");

    const characterSave = sourceBetween(
      application,
      'const form = $("#character-editor-form");\n  form.onsubmit = async (event) => {',
      'showEntityEditorPage("character"'
    );
    expect(characterSave).toContain("characterEditorItem = saved");
    expect(characterSave).toContain('`人物档案已保存为 v${saved.versionNo}`');
    expect(characterSave).not.toContain("closeEntityEditor");
    expect(characterSave).not.toContain("loadAiReferences");

    const knowledgeSave = sourceBetween(
      application,
      'const form = $("#knowledge-editor-form");\n  form.onsubmit = async (event) => {',
      "async function openRaceDialog"
    );
    expect(knowledgeSave).toContain("knowledgeEditorItem = saved");
    expect(knowledgeSave).toContain('`${label}档案已保存为 v${saved.versionNo}`');
    expect(knowledgeSave).not.toContain("closeEntityEditor");
    expect(knowledgeSave).not.toContain("loadAiReferences");
  });

  it("局部更新嵌套 Markdown 章节且不重新请求角色列表", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");

    const knowledgeSectionSave = sourceBetween(
      application,
      'host.querySelector("[data-knowledge-section-edit-save]").addEventListener',
      "function characterSectionEditorHtml"
    );
    expect(knowledgeSectionSave).toContain("knowledgeSectionEditorDirty = false");
    expect(knowledgeSectionSave).not.toContain("closeKnowledgeSectionEditor");

    const characterSectionSave = sourceBetween(
      application,
      'host.querySelector("[data-character-section-edit-save]").addEventListener',
      "async function showCharacterSectionVersions"
    );
    expect(characterSectionSave).toContain("upsertCharacterEditorSection(saved)");
    expect(characterSectionSave).not.toContain("renderCharacters()");
    expect(characterSectionSave).not.toContain("closeCharacterSectionEditor");
    expect(characterSectionSave).not.toContain("loadAiReferences");
    expect(characterSectionSave).not.toContain('characterEditorSections = await api(`/api/characters/${characterEditorItem.id}/sections`)');
  });
});
