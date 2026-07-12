export function collapseExcessBlankLines(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\n(?:[\t\p{Zs}\uFEFF]*\n){2,}/gu, "\n\n");
}

export function normalizeParagraphSpacing(value) {
  return collapseExcessBlankLines(value)
    .replace(/[\t\p{Zs}\uFEFF]+$/gmu, "")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "")
    .replace(/\n{3,}/gu, "\n\n");
}
