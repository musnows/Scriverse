export function calculateLineNumberTop(paddingTop, contentLineHeight, numberLineHeight) {
  return Number(paddingTop);
}

export function calculateLineNumberTextOffset(contentLineHeight, numberLineHeight) {
  return Math.max(0, (Number(contentLineHeight) - Number(numberLineHeight)) / 2);
}

export function calculateLineNumberRowHeight(contentLineHeight, measuredHeight) {
  return Math.max(Number(contentLineHeight), Number(measuredHeight));
}

export function calculateLineNumberRowTop(measureTop, rowTop) {
  return Math.max(0, Number(rowTop) - Number(measureTop));
}
