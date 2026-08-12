export type ChapterDiffRow =
  | { type: "equal"; before: string; after: string; beforeLine: number; afterLine: number }
  | { type: "added"; after: string; afterLine: number }
  | { type: "deleted"; before: string; beforeLine: number }
  | { type: "modified"; before: string; after: string; beforeLine: number; afterLine: number };

export type ChapterDiffSummary = {
  added: number;
  deleted: number;
  modified: number;
  unchanged: number;
};

export function diffChapterLines(
  beforeContent: unknown,
  afterContent: unknown,
  matrixCellLimit?: number
): ChapterDiffRow[];

export function chapterDiffSummary(rows: ChapterDiffRow[]): ChapterDiffSummary;
