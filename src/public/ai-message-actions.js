function copyWithDocument(rawMarkdown, documentRef) {
  if (!documentRef?.body || typeof documentRef.execCommand !== "function") return false;
  const textarea = documentRef.createElement("textarea");
  textarea.value = rawMarkdown;
  textarea.setAttribute("readonly", "");
  Object.assign(textarea.style, { position: "fixed", left: "-9999px", opacity: "0" });
  documentRef.body.append(textarea);
  textarea.select();
  const copied = documentRef.execCommand("copy");
  textarea.remove();
  return copied;
}

export async function copyAiRawMarkdown(markdown, clipboard = globalThis.navigator?.clipboard, documentRef = globalThis.document) {
  const rawMarkdown = String(markdown ?? "");
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(rawMarkdown);
      return rawMarkdown;
    } catch {
      if (copyWithDocument(rawMarkdown, documentRef)) return rawMarkdown;
    }
  } else if (copyWithDocument(rawMarkdown, documentRef)) {
    return rawMarkdown;
  }
  throw new Error("当前浏览器不支持剪贴板写入");
}
