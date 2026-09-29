import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { applyChapterDirectoryMove } from "../../src/public/chapter-directory.js";

const application = readFileSync("src/public/app.js", "utf8");
function sourceBetween(start: string, end: string) {
  return application.slice(application.indexOf(start), application.indexOf(end, application.indexOf(start)));
}
function fixture() {
  const chapter = { id: "one", workId: "work", volumeId: "a", sortOrder: 0, versionNo: 1 };
  const context = {
    state: { work: { id: "work", volumes: [
      { id: "a", chapters: [chapter, { ...chapter, id: "two", sortOrder: 1 }], chapterCount: 2 },
      { id: "b", chapters: [], chapterCount: 0 }
    ] }, chapter: { ...chapter, content: "saved prose" } },
    chapterMovePending: false,
    workScopedUiGeneration: 1,
    loadedVolumeChapterIds: new Set(["a", "b"]),
    canEditProse: () => true,
    loadVolumeChapters: vi.fn(async (_volumeId: string) => undefined),
    applyChapterDirectoryMove,
    syncMovedChapterTree: vi.fn(),
    updateChapterPath: vi.fn(),
    updateChapterStats: vi.fn(),
    api: vi.fn(async () => ({ ...chapter, sortOrder: 1, versionNo: 2 })),
    toast: vi.fn(),
    $: () => ({ querySelector: () => ({ focus: vi.fn() }) }),
    CSS: { escape: (value: string) => value }
  };
  const move = runInNewContext(`${sourceBetween("function findChapterLocation(", "\nasync function moveChapterByKeyboard")}\nmoveChapterInTree`, context) as (chapterId: string, volumeId: string, sortOrder: number) => Promise<void>;
  return { context, move };
}

describe("目录性能与异步边界", () => {
  it("排序只发送一次写请求并同步局部目录，不重取全书", async () => {
    const { context, move } = fixture();
    const work = context.state.work;
    await move("one", "a", 1);
    expect(context.api).toHaveBeenCalledExactlyOnceWith("/api/chapters/one/move", {
      method: "POST", body: { volumeId: "a", sortOrder: 1, expectedVersionNo: 1 }
    });
    expect(context.state.work).toBe(work);
    expect(work.volumes[0]!.chapters.map(item => item.id)).toEqual(["two", "one"]);
    expect(context.syncMovedChapterTree).toHaveBeenCalledExactlyOnceWith("one", ["a"]);
    expect(context.state.chapter).toMatchObject({ versionNo: 2, content: "saved prose" });
    expect(context.chapterMovePending).toBe(false);
  });

  it("失败不修改顺序，原位操作不发送请求", async () => {
    const { context, move } = fixture();
    await move("one", "a", 0);
    expect(context.api).not.toHaveBeenCalled();
    context.api.mockRejectedValueOnce(new Error("Move failed"));
    await move("one", "a", 1);
    expect(context.state.work.volumes[0]!.chapters.map(item => item.id)).toEqual(["one", "two"]);
    expect(context.syncMovedChapterTree).not.toHaveBeenCalled();
    expect(context.toast).toHaveBeenCalledWith("Move failed", "error");
    expect(context.chapterMovePending).toBe(false);
  });

  it("切换作品后丢弃旧排序响应，并阻止重复提交", async () => {
    const { context, move } = fixture();
    let resolve!: (chapter: { id: string; workId: string; volumeId: string; sortOrder: number; versionNo: number }) => void;
    context.api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = move("one", "a", 1);
    await vi.waitFor(() => expect(context.api).toHaveBeenCalledOnce());
    await move("one", "a", 1);
    expect(context.api).toHaveBeenCalledOnce();
    context.state.work = { id: "other", volumes: [] };
    context.workScopedUiGeneration += 1;
    resolve({ id: "one", workId: "work", volumeId: "a", sortOrder: 1, versionNo: 2 });
    await pending;
    expect(context.state.work.id).toBe("other");
    expect(context.syncMovedChapterTree).not.toHaveBeenCalled();
    expect(context.toast).not.toHaveBeenCalled();
  });

  it("等待目标卷加载完成后再执行跨卷移动", async () => {
    const { context, move } = fixture();
    context.loadedVolumeChapterIds.delete("b");
    await move("one", "b", 0);
    expect(context.loadVolumeChapters.mock.calls.map(args => args[0])).toEqual(["a", "b"]);
    expect(context.api).not.toHaveBeenCalled();
    expect(context.chapterMovePending).toBe(false);
  });

  it("章节选择复用已有目录节点，只更新选中状态和元数据", () => {
    const previous = { classList: { remove: vi.fn() } };
    const label = { textContent: "old" };
    const count = { textContent: "0" };
    const button = {
      classList: { add: vi.fn() },
      closest: () => ({ classList: { contains: () => false } }),
      firstElementChild: label,
      querySelector: (selector: string) => selector === "small" ? count : null
    };
    const renderTree = vi.fn();
    const tree = { querySelectorAll: () => [previous], querySelector: () => button };
    const sync = runInNewContext(`${sourceBetween("function syncChapterTreeSelection(", "\nfunction syncMovedChapterTree")}\nsyncChapterTreeSelection`, {
      $: () => tree, CSS: { escape: (value: string) => value }, renderTree,
      state: { chapter: { id: "two", volumeId: "a", title: "第二章", wordCount: 1200, chapterType: "正文" } }
    }) as () => void;
    sync();
    expect(renderTree).not.toHaveBeenCalled();
    expect(previous.classList.remove).toHaveBeenCalledWith("active");
    expect(button.classList.add).toHaveBeenCalledWith("active");
    expect(label.textContent).toBe("第二章");
    expect(count.textContent).toBe("1,200");
  });

  it("缓存版本覆盖目录模块，章节打开不等待辅助提醒接口", () => {
    expect(readFileSync("src/public/index.html", "utf8")).toContain("feature=chapter-directory-performance-v2");
    expect(readFileSync("src/public/index.html", "utf8")).toContain("feature=chapter-switch-skeleton-v1");
    expect(application).toContain('/chapter-directory.js?v=20260921-directory-performance-v1');
    const select = sourceBetween("async function selectChapter(", "\nfunction updateChapterPath(");
    const paintAt = select.indexOf("presentChapter(previewChapter, { editMode: false, contentReady: false })");
    const requestAt = select.indexOf("selectedChapter = await api");
    expect(paintAt).toBeGreaterThan(-1);
    expect(requestAt).toBeGreaterThan(paintAt);
    expect(select.indexOf("syncChapterTreeSelection();")).toBeGreaterThan(-1);
    expect(select.indexOf("syncChapterTreeSelection();")).toBeLessThan(requestAt);
    expect(select).toContain('presentChapter(previewChapter, { editMode: false, contentReady: false })');
    expect(select).toContain("content: \"\"");
    expect(select).not.toContain("cachedChapterBody(");
    expect(select).not.toContain("rememberChapterBody(");
    expect(readFileSync("src/public/index.html", "utf8")).toContain('id="chapter-content-skeleton"');
    expect(application).toContain("function setChapterContentSkeleton(visible)");
    expect(application).toContain("setChapterContentSkeleton(!contentReady);");
    expect(select).toContain("void loadChapterForeshadowReminders();");
    expect(select).not.toContain("await loadChapterForeshadowReminders();");
    expect(select).not.toContain("await api(`/api/works/");
    expect(application).toContain("function chapterEditingLocked()");
    expect(application).toContain("if (chapterEditingLocked()) return;");
    expect(application).toContain("editButton.disabled = waitingForChapter;");
    const characters = sourceBetween("async function renderCharacters(", "\nasync function renderRaces(");
    expect(characters).toContain("const needsCharacterFilterCatalog = hasCharacterFilters || characterFiltersPanelOpen;");
    expect(characters).toContain('needsCharacterFilterCatalog && canReadModule("races") ? moduleApi("characters", `/api/works/${state.work.id}/races`)');
    expect(characters).toContain('needsCharacterFilterCatalog && canReadModule("organizations") ? moduleApiAllPages("characters", `/api/works/${state.work.id}/organizations`)');
  });
});
