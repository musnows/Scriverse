import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const application = readFileSync("src/public/app.js", "utf8");
const transitionStart = application.indexOf('$("#draft-dialog-edit")?.addEventListener("click", () => {');
const transitionEnd = application.indexOf("\n    });", transitionStart) + "\n    });".length;
const closeStart = application.indexOf('$("#form-dialog").addEventListener("close", () => {');
const closeEnd = application.indexOf("\n});", closeStart) + "\n});".length;

type Editor = { value: string; destroyed: boolean };

class ModalDialog extends EventTarget {
  open = true;
  private closeEvents: Event[] = [];

  close() {
    this.open = false;
    this.closeEvents.push(new Event("close"));
  }

  showModal() {
    this.open = true;
  }

  flushCloseEvents() {
    this.closeEvents.splice(0).forEach((event) => this.dispatchEvent(event));
  }
}

function fixture() {
  const dialog = new ModalDialog();
  const editButton = new EventTarget();
  const initialEditor: Editor = { value: "Original draft content", destroyed: false };
  const editors = [initialEditor];
  const openings: Promise<void>[] = [];
  let menuClosures = 0;
  let titleFocuses = 0;
  const titleInput = { focus: () => { titleFocuses += 1; } };
  const context = {
    $: (selector: string) => selector === "#form-dialog" ? dialog : selector === "#dialog-title-input" ? titleInput : editButton,
    draftDialogItem: { content: initialEditor.value },
    formDialogVditors: [initialEditor],
    destroyVditorEditor: (editor: Editor) => { editor.destroyed = true; },
    discardPendingMarkdownAttachments: async () => undefined,
    closeManuscriptExportMenu: () => { menuClosures += 1; },
    relationshipPresenceId: null,
    setRelationshipPresence: () => undefined,
    openDraftDialog: (item: { content: string }): void => {
      openings.push((async () => {
        context.formDialogVditors.forEach(context.destroyVditorEditor);
        context.formDialogVditors = [];
        await Promise.resolve();
        const editor = { value: item.content, destroyed: false };
        editors.push(editor);
        context.formDialogVditors = [editor];
        dialog.showModal();
      })());
    }
  };
  runInNewContext(application.slice(transitionStart, transitionEnd), context);
  runInNewContext(application.slice(closeStart, closeEnd), context);
  const flush = async () => {
    await Promise.all(openings);
    dialog.flushCloseEvents();
  };
  return { dialog, editButton, initialEditor, editors, context, flush, menuClosures: () => menuClosures, titleFocuses: () => titleFocuses };
}

describe("想法查看切换到编辑", () => {
  it("旧弹窗的延迟关闭事件不会销毁新编辑器或清空原文", async () => {
    const state = fixture();
    state.editButton.dispatchEvent(new Event("click"));
    await state.flush();

    expect(state.initialEditor.destroyed).toBe(true);
    expect(state.dialog.open).toBe(true);
    expect(state.context.formDialogVditors).toEqual([{ value: "Original draft content", destroyed: false }]);
    expect(state.editors.at(-1)?.destroyed).toBe(false);
    expect(state.titleFocuses()).toBe(1);
  });

  it("用户真正关闭编辑弹窗时仍清理当前编辑器和菜单", async () => {
    const state = fixture();
    state.editButton.dispatchEvent(new Event("click"));
    await state.flush();
    state.dialog.close();
    await state.flush();

    expect(state.dialog.open).toBe(false);
    expect(state.editors.every((editor) => editor.destroyed)).toBe(true);
    expect(state.context.formDialogVditors).toEqual([]);
    expect(state.menuClosures()).toBe(1);
  });

  it("连续切换只销毁旧实例并保留当前编辑器", async () => {
    const state = fixture();
    for (let index = 0; index < 3; index += 1) {
      state.editButton.dispatchEvent(new Event("click"));
      await state.flush();
    }

    expect(state.editors.slice(0, -1).every((editor) => editor.destroyed)).toBe(true);
    expect(state.editors.at(-1)).toEqual({ value: "Original draft content", destroyed: false });
    expect(state.context.formDialogVditors).toHaveLength(1);
  });
});
