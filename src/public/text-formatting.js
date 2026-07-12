export function normalizeParagraphSpacing(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\p{Zs}\uFEFF]+$/gmu, "")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "")
    .replace(/\n{3,}/gu, "\n\n");
}
