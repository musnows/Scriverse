import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("设定库实体编辑器保存体验", () => {
  it("从采集快照到延迟响应完成期间锁定编辑区域并阻止继续输入", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const saveSource = sourceBetween(application, "async function runEntityEditorSave(", "\nfunction upsertEntityCollection");
    const button = {
      disabled: false,
      textContent: "保存新版本",
      isConnected: true,
      focus: () => undefined
    };
    const busyTarget = {
      inert: false,
      busy: false,
      setAttribute(name: string, value: string) {
        if (name === "aria-busy") this.busy = value === "true";
      },
      removeAttribute(name: string) {
        if (name === "aria-busy") this.busy = false;
      },
      contains: () => true
    };
    const context = {
      document: { activeElement: button },
      window: { setTimeout },
      toast: () => undefined
    };
    const runEntityEditorSave = vm.runInNewContext(`${saveSource}\nrunEntityEditorSave`, context) as (options: {
      busyTarget: typeof busyTarget;
      button: typeof button;
      prepare: () => Promise<string>;
      save: (prepared: string) => Promise<{ message: string }>;
    }) => Promise<unknown>;

    let releasePreparation: (() => void) | undefined;
    let notifySnapshotCaptured: (() => void) | undefined;
    let releaseResponse: (() => void) | undefined;
    let notifyRequestStarted: (() => void) | undefined;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const snapshotCaptured = new Promise<void>((resolve) => { notifySnapshotCaptured = resolve; });
    const response = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requestStarted = new Promise<void>((resolve) => { notifyRequestStarted = resolve; });
    let fieldValue = "提交快照";
    let sentValue = "";
    let dirty = true;
    const savePromise = runEntityEditorSave({
      busyTarget,
      button,
      prepare: async () => {
        const snapshot = fieldValue;
        notifySnapshotCaptured?.();
        await preparation;
        return snapshot;
      },
      save: async (prepared) => {
        sentValue = prepared;
        notifyRequestStarted?.();
        await response;
        dirty = false;
        return { message: "保存成功" };
      }
    });

    await snapshotCaptured;
    expect(busyTarget.inert).toBe(true);
    expect(busyTarget.busy).toBe(true);
    if (!busyTarget.inert) {
      fieldValue = "确认期间继续输入";
      dirty = true;
    }
    releasePreparation?.();
    await requestStarted;
    expect(busyTarget.inert).toBe(true);
    expect(busyTarget.busy).toBe(true);
    if (!busyTarget.inert) {
      fieldValue = "响应前继续输入";
      dirty = true;
    }
    releaseResponse?.();
    await savePromise;

    expect(sentValue).toBe("提交快照");
    expect(fieldValue).toBe("提交快照");
    expect(dirty).toBe(false);
    expect(busyTarget.inert).toBe(false);
    expect(busyTarget.busy).toBe(false);
  });

  it("保存成功后忽略已保存快照的延迟输入并保留后续修改提示", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const trackerSource = sourceBetween(application, "function createEditorDirtyTracker(", "\nlet settingEditorItem");
    const createEditorDirtyTracker = vm.runInNewContext(`${trackerSource}\ncreateEditorDirtyTracker`) as (snapshot?: string) => {
      markSaved: (snapshot: string) => void;
      isDirty: (snapshot: string) => boolean;
    };
    const tracker = createEditorDirtyTracker("打开时快照");

    expect(tracker.isDirty("提交快照")).toBe(true);
    tracker.markSaved("提交快照");
    const delayedInputDirty = await Promise.resolve().then(() => tracker.isDirty("提交快照"));
    expect(delayedInputDirty).toBe(false);
    expect(tracker.isDirty("保存后继续修改")).toBe(true);

    const settingSave = sourceBetween(application, "function settingEditorSnapshot(", "\nfunction characterEditorSection");
    expect(settingSave).toContain("settingEditorDirtyTracker.markSaved(settingEditorSnapshot(body.content))");
    expect(settingSave).toContain("onInput: (markdown) => syncSettingEditorDirty(markdown)");
    expect(application).toContain('$("#setting-editor-form").addEventListener("input", () => syncSettingEditorDirty())');

    const characterSectionSave = sourceBetween(application, "function characterSectionEditorSnapshot(", "\nasync function showCharacterSectionVersions");
    expect(characterSectionSave).toContain("characterSectionEditorDirtyTracker.markSaved(characterSectionEditorSnapshot(contentMarkdown))");
    expect(characterSectionSave).toContain("onInput: (markdown) => syncCharacterSectionEditorDirty(markdown)");
  });

  it("统一显示保存状态并在成功或失败后保持编辑器打开", async () => {
    const publicPath = join(process.cwd(), "src/public");
    const [application, page] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8")
    ]);

    expect(application).toContain("async function runEntityEditorSave(");
    expect(application).toContain('busyTarget.setAttribute("aria-busy", "true")');
    expect(application).toContain("busyTarget.inert = true");
    expect(application).toContain("busyTarget.inert = initialInert");
    expect(application).toContain('button.textContent = "保存中…"');
    expect(application).toContain('toast("正在保存…")');
    expect(application).toContain('toast(error instanceof Error ? error.message : "保存失败，请重试", "error")');
    expect(application).toContain('busyTarget.removeAttribute("aria-busy")');
    expect(application.match(/await runEntityEditorSave\(\{/gu)).toHaveLength(5);
    expect(application).toContain("function isEntityEditorSaving()");
    expect(application.match(/toast\("正在保存，请稍候"\)/gu)).toHaveLength(3);
    expect(page).toContain('/app.js?v=20260812-image-upload-progress-v1');

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
