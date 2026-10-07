import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const application = readFileSync("src/public/app.js", "utf8");
const dialogStart = application.indexOf("async function openDialog(");
const submitStart = application.indexOf("  form.onsubmit = async (event) => {", dialogStart);
const submitEnd = application.indexOf("\n  dialog.showModal();", submitStart);
const syncStart = application.indexOf("function syncVditorEditorValues(");
const syncEnd = application.indexOf("\nfunction ", syncStart + 1);
const syncSource = syncStart < 0 ? "" : application.slice(syncStart, syncEnd);

type MarkdownField = {
  name: string;
  value: string;
  readOnly: boolean;
  disabled: boolean;
};
type FieldOptions = { name?: string; cached: string; current?: string; readOnly?: boolean; error?: Error };

function fixture(options: FieldOptions[]) {
  const fields: MarkdownField[] = options.map((option, index) => ({
    name: option.name ?? `content${index}`,
    value: option.cached,
    readOnly: option.readOnly ?? false,
    disabled: false
  }));
  const reads = options.map((option) => vi.fn(() => {
    if (option.error) throw option.error;
    return option.current;
  }));
  const hosts = options.map((option, index) => ({
    __vditor: option.current === undefined && !option.error ? null : { getValue: reads[index] },
    parentElement: { querySelector: () => fields[index] }
  }));
  const classList = () => ({ add: vi.fn(), remove: vi.fn() });
  const form = {
    elements: fields,
    querySelectorAll: (selector: string) => selector === "[data-vditor-editor]" ? hosts : fields,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    classList: classList(),
    onsubmit: async (_event: { preventDefault(): void; submitter?: { value: string } }) => undefined
  };
  const onSubmit = vi.fn(async (_values: Map<string, string>) => undefined);
  const close = vi.fn();
  const toast = vi.fn();
  const context = {
    form,
    // 新建章节的回车守卫在 openDialog 闭包里，片段执行时默认不启用。
    chapterEnterGuard: null,
    submitting: false,
    disabledStates: [],
    submit: { textContent: "Save" },
    submitStatus: { classList: classList() },
    options: {},
    submitLabel: "Save",
    dialog: { close },
    commitRelationshipKeywordInputs: vi.fn(),
    discardPendingMarkdownAttachments: vi.fn(async () => undefined),
    cleanupPendingMarkdownAttachments: vi.fn(async (_markdown: string) => undefined),
    onSubmit,
    toast,
    Error,
    FormData: class extends Map<string, string> {
      constructor() {
        super(fields.map((field) => [field.name, field.value]));
      }
    }
  };
  runInNewContext(`${syncSource}\n${application.slice(submitStart, submitEnd)}`, context);
  const submit = (value = "save") => form.onsubmit({ preventDefault: vi.fn(), submitter: { value } });
  return { fields, reads, onSubmit, close, toast, submit };
}

describe("Markdown 表单即时保存", () => {
  it("input 回调尚未更新隐藏字段时也保存编辑器中的最新正文", async () => {
    const state = fixture([{ cached: "Old content", current: "Latest typed content" }]);
    await state.submit();

    expect(state.onSubmit).toHaveBeenCalledOnce();
    expect(state.onSubmit.mock.calls[0]?.[0].get("content0")).toBe("Latest typed content");
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("分别同步多个编辑器并允许清空正文", async () => {
    const state = fixture([
      { name: "description", cached: "Old description", current: "New description" },
      { name: "notes", cached: "Old notes", current: "" }
    ]);
    await state.submit();

    expect([...state.onSubmit.mock.calls[0]?.[0] ?? []]).toEqual([["description", "New description"], ["notes", ""]]);
  });

  it("读取编辑器失败时保留原字段且不提交过时正文", async () => {
    const state = fixture([{ cached: "Original content", error: new Error("Editor unavailable") }]);
    await state.submit();

    expect(state.onSubmit).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(state.fields[0]?.value).toBe("Original content");
    expect(state.toast).toHaveBeenCalledWith("Editor unavailable", "error");
  });

  it("只读字段和没有编辑器实例的字段保持原值", async () => {
    const state = fixture([
      { cached: "Read-only content", current: "Normalized content", readOnly: true },
      { cached: "Uninitialized content" }
    ]);
    await state.submit();

    expect([...state.onSubmit.mock.calls[0]?.[0].values() ?? []]).toEqual(["Read-only content", "Uninitialized content"]);
    expect(state.reads.every((read) => read.mock.calls.length === 0)).toBe(true);
  });

  it("取消时不读取编辑器或提交修改", async () => {
    const state = fixture([{ cached: "Original content", current: "Unsaved content" }]);
    await state.submit("cancel");

    expect(state.onSubmit).not.toHaveBeenCalled();
    expect(state.reads[0]).not.toHaveBeenCalled();
    expect(state.fields[0]?.value).toBe("Original content");
  });
});
