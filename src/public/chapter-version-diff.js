const DEFAULT_MATRIX_CELL_LIMIT = 2_000_000;

function chapterLines(content) {
  return String(content ?? "").replace(/\r\n?/gu, "\n").split("\n");
}

function positionalDiff(beforeLines, afterLines) {
  const rows = [];
  const length = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < length; index += 1) {
    const before = beforeLines[index];
    const after = afterLines[index];
    if (before === undefined) rows.push({ type: "added", after, afterLine: index + 1 });
    else if (after === undefined) rows.push({ type: "deleted", before, beforeLine: index + 1 });
    else if (before === after) rows.push({ type: "equal", before, after, beforeLine: index + 1, afterLine: index + 1 });
    else rows.push({ type: "modified", before, after, beforeLine: index + 1, afterLine: index + 1 });
  }
  return rows;
}

function rawLineDiff(beforeLines, afterLines, matrixCellLimit) {
  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;
  if (rows * columns > matrixCellLimit) return null;
  const matrix = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      matrix[beforeIndex][afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? matrix[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(matrix[beforeIndex + 1][afterIndex], matrix[beforeIndex][afterIndex + 1]);
    }
  }

  const diff = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeIndex < beforeLines.length && afterIndex < afterLines.length
      && beforeLines[beforeIndex] === afterLines[afterIndex]) {
      diff.push({ type: "equal", text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1, afterLine: afterIndex + 1 });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (afterIndex < afterLines.length
      && (beforeIndex >= beforeLines.length || matrix[beforeIndex][afterIndex + 1] >= matrix[beforeIndex + 1][afterIndex])) {
      diff.push({ type: "added", text: afterLines[afterIndex], afterLine: afterIndex + 1 });
      afterIndex += 1;
    } else {
      diff.push({ type: "deleted", text: beforeLines[beforeIndex], beforeLine: beforeIndex + 1 });
      beforeIndex += 1;
    }
  }
  return diff;
}

function pairChangedLines(changes) {
  const deleted = changes.filter((row) => row.type === "deleted");
  const added = changes.filter((row) => row.type === "added");
  const paired = [];
  const pairCount = Math.min(deleted.length, added.length);
  for (let index = 0; index < pairCount; index += 1) {
    paired.push({
      type: "modified",
      before: deleted[index].text,
      after: added[index].text,
      beforeLine: deleted[index].beforeLine,
      afterLine: added[index].afterLine
    });
  }
  for (let index = pairCount; index < deleted.length; index += 1) {
    paired.push({ type: "deleted", before: deleted[index].text, beforeLine: deleted[index].beforeLine });
  }
  for (let index = pairCount; index < added.length; index += 1) {
    paired.push({ type: "added", after: added[index].text, afterLine: added[index].afterLine });
  }
  return paired;
}

export function diffChapterLines(beforeContent, afterContent, matrixCellLimit = DEFAULT_MATRIX_CELL_LIMIT) {
  const beforeLines = chapterLines(beforeContent);
  const afterLines = chapterLines(afterContent);
  const raw = rawLineDiff(beforeLines, afterLines, matrixCellLimit);
  if (!raw) return positionalDiff(beforeLines, afterLines);

  const result = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index].type === "equal") {
      result.push({
        type: "equal",
        before: raw[index].text,
        after: raw[index].text,
        beforeLine: raw[index].beforeLine,
        afterLine: raw[index].afterLine
      });
      index += 1;
      continue;
    }
    const changes = [];
    while (index < raw.length && raw[index].type !== "equal") {
      changes.push(raw[index]);
      index += 1;
    }
    result.push(...pairChangedLines(changes));
  }
  return result;
}

export function chapterDiffSummary(rows) {
  return rows.reduce((summary, row) => {
    if (row.type === "added") summary.added += 1;
    if (row.type === "deleted") summary.deleted += 1;
    if (row.type === "modified") summary.modified += 1;
    if (row.type === "equal") summary.unchanged += 1;
    return summary;
  }, { added: 0, deleted: 0, modified: 0, unchanged: 0 });
}
