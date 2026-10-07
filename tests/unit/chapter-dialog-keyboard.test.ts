import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { bindChapterCreateEnterGuard, shouldSuppressChapterCreateEnter } from "../../src/public/chapter-dialog-keyboard.js";

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: "Enter",
    isComposing: false,
    keyCode: 13,
    preventDefault: vi.fn(),
    ...overrides
  };
}

describe("新建章节回车", () => {
  it("Enter 需要被忽略，输入法确认和其它按键除外", () => {
    expect(shouldSuppressChapterCreateEnter(keyEvent())).toBe(true);
    expect(shouldSuppressChapterCreateEnter(keyEvent({ isComposing: true }))).toBe(false);
    expect(shouldSuppressChapterCreateEnter(keyEvent({ keyCode: 229 }))).toBe(false);
    expect(shouldSuppressChapterCreateEnter(keyEvent({ key: "Escape" }))).toBe(false);
    expect(shouldSuppressChapterCreateEnter(keyEvent({ key: " " }))).toBe(false);
  });

  it("Enter 不提交；微任务之后点击确认仍然可以提交", async () => {
    const form: { onkeydown: ((event: ReturnType<typeof keyEvent>) => void) | null } = { onkeydown: null };
    const guard = bindChapterCreateEnterGuard(form);
    const enter = keyEvent();
    form.onkeydown?.(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();

    const implicitSubmit = keyEvent();
    expect(guard.consumeSuppressedEnter(implicitSubmit)).toBe(true);
    expect(implicitSubmit.preventDefault).toHaveBeenCalledOnce();

    await Promise.resolve();
    const clickSubmit = keyEvent();
    expect(guard.consumeSuppressedEnter(clickSubmit)).toBe(false);
    expect(clickSubmit.preventDefault).not.toHaveBeenCalled();
  });

  it("没有同步提交时，回车结束后的点击确认仍然有效", async () => {
    const form: { onkeydown: ((event: ReturnType<typeof keyEvent>) => void) | null } = { onkeydown: null };
    const guard = bindChapterCreateEnterGuard(form);
    form.onkeydown?.(keyEvent());
    await Promise.resolve();
    const clickSubmit = keyEvent();
    expect(guard.consumeSuppressedEnter(clickSubmit)).toBe(false);
    expect(clickSubmit.preventDefault).not.toHaveBeenCalled();
  });

  it("只在新建章节对话框启用，其它对话框保持原有回车行为", () => {
    const application = readFileSync("src/public/app.js", "utf8");
    const page = readFileSync("src/public/index.html", "utf8");
    const chapterDialog = application.slice(
      application.indexOf("async function openChapterDialog"),
      application.indexOf("function openVolumeDialog")
    );
    expect(chapterDialog).toContain("suppressEnter: true");
    expect(application.match(/suppressEnter:\s*true/g)).toEqual(["suppressEnter: true"]);
    expect(application).toContain("bindChapterCreateEnterGuard(form)");
    expect(application).toContain('from "/chapter-dialog-keyboard.js?v=20261007-chapter-create-enter-noop-v1"');
    expect(page).toContain("feature=chapter-create-enter-noop-v1");
  });
});
