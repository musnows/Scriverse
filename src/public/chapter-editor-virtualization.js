const lineMarker = "\u200b";

export function buildChapterLineMirror(value) {
  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const offsets = [];
  const parts = [];
  let offset = 0;
  lines.forEach((line, index) => {
    offsets.push(offset);
    parts.push(lineMarker, line);
    offset += lineMarker.length + line.length;
    if (index < lines.length - 1) {
      parts.push("\n");
      offset += 1;
    }
  });
  return { lines, offsets, text: parts.join("") };
}

export function findChapterLineWindow(lineCount, getBounds, viewportStart, viewportEnd) {
  const count = Math.max(0, Math.floor(Number(lineCount) || 0));
  if (count === 0) return { start: 0, end: 0 };
  const startTarget = Number.isFinite(Number(viewportStart)) ? Number(viewportStart) : 0;
  const endTarget = Math.max(startTarget, Number.isFinite(Number(viewportEnd)) ? Number(viewportEnd) : startTarget);

  let low = 0;
  let high = count - 1;
  let start = count - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (getBounds(middle).bottom >= startTarget) {
      start = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  low = start;
  high = count - 1;
  let end = start;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (getBounds(middle).top <= endTarget) {
      end = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { start, end: end + 1 };
}
