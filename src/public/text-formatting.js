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

export function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
