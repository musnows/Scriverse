function normalizePlainText(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n");
}

export function readClipboardPlainText(clipboardData) {
  if (!clipboardData || typeof clipboardData.getData !== "function") return "";
  try {
    return normalizePlainText(clipboardData.getData("text/plain"));
  } catch {
    return "";
  }
}

function isInside(root, node) {
  return Boolean(node) && (node === root || root.contains(node));
}

function insertIntoContentEditable(target, text, documentRef, windowRef) {
  const selection = windowRef?.getSelection?.();
  const currentRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const range = currentRange && isInside(target, currentRange.commonAncestorContainer)
    ? currentRange.cloneRange()
    : documentRef.createRange();
  if (!currentRange || !isInside(target, currentRange.commonAncestorContainer)) {
    target.focus?.();
    range.selectNodeContents(target);
    range.collapse(false);
  }
  range.deleteContents();
  const fragment = documentRef.createDocumentFragment();
  normalizePlainText(text).split("\n").forEach((line, index) => {
    if (index > 0) fragment.append(documentRef.createElement("br"));
    if (line) fragment.append(documentRef.createTextNode(line));
  });
  range.insertNode(fragment);
  range.collapse(false);
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

function insertIntoTextArea(target, text) {
  const value = String(target.value ?? "");
  const start = Number.isInteger(target.selectionStart) ? target.selectionStart : value.length;
  const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
  target.value = `${value.slice(0, start)}${normalizePlainText(text)}${value.slice(end)}`;
  target.setSelectionRange?.(start + normalizePlainText(text).length, start + normalizePlainText(text).length);
  return true;
}

function dispatchInput(target, text, windowRef) {
  const InputEventConstructor = windowRef?.InputEvent;
  const EventConstructor = windowRef?.Event;
  if (typeof InputEventConstructor === "function") {
    target.dispatchEvent(new InputEventConstructor("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  } else if (typeof EventConstructor === "function") {
    target.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  }
}

export function insertClipboardPlainText(target, text, documentRef = globalThis.document, windowRef = globalThis.window) {
  if (!target) return false;
  if (target.tagName === "TEXTAREA") return insertIntoTextArea(target, text);
  if (target.getAttribute?.("contenteditable") === "true") return insertIntoContentEditable(target, text, documentRef, windowRef);
  return false;
}

function pasteTarget(event, root) {
  let target = event.target;
  if (target?.nodeType !== 1) target = target?.parentElement;
  const editable = target?.closest?.("textarea, [contenteditable=\"true\"]");
  return editable && isInside(root, editable) ? editable : null;
}

export function bindPlainTextPaste(root, documentRef = globalThis.document, windowRef = globalThis.window) {
  if (!root) return () => {};
  const handler = (event) => {
    const target = pasteTarget(event, root);
    if (!target) return;
    const text = readClipboardPlainText(event.clipboardData);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (insertClipboardPlainText(target, text, documentRef, windowRef)) dispatchInput(target, text, windowRef);
  };
  root.addEventListener("paste", handler, true);
  return () => root.removeEventListener("paste", handler, true);
}
