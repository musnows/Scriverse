export type ReadingMode = "scroll" | "paged";
export type ReadingTheme = "auto" | "paper" | "light" | "dark";
export type ResolvedReadingTheme = Exclude<ReadingTheme, "auto">;
export type ReadingPreferences = { mode: ReadingMode; fontSize: number; lineHeight: number; theme: ReadingTheme };
export type ReadingChapter = {
  id: string;
  workId: string;
  volumeId: string;
  volumeTitle: string;
  title: string;
  chapterType: string;
  volumeIndex: number;
  chapterIndex: number;
  sequenceIndex: number;
};
export type ReadingPosition = { chapterId: string; scrollRatio: number; pageIndex: number };

export const READING_PREFERENCES_STORAGE_KEY: string;
export const READING_POSITION_STORAGE_PREFIX: string;
export const READING_PREFERENCES_VERSION: number;
export const DEFAULT_READING_PREFERENCES: Readonly<ReadingPreferences>;
export function normalizeReadingPreferences(value: unknown): ReadingPreferences;
export function normalizeStoredReadingPreferences(value: unknown): ReadingPreferences;
export function resolveReadingTheme(theme: unknown, colorTheme: unknown): ResolvedReadingTheme;
export function readingPositionStorageKey(workId: unknown): string;
export function buildReadingChapterSequence(work: unknown): ReadingChapter[];
export function normalizeReadingPosition(value: unknown, sequence: ReadingChapter[]): ReadingPosition | null;
export function resolveReadingStart(sequence: ReadingChapter[], options?: { chapterId?: unknown; volumeId?: unknown; storedPosition?: unknown }): ReadingChapter | null;
export function adjacentReadingChapter(sequence: ReadingChapter[], chapterId: string, direction: number): ReadingChapter | null;
export function resolvePagedReadingStep(input: { sequence: ReadingChapter[]; chapterId: string; pageIndex: number; pageCount: number }, direction: number): { chapterId: string; pageIndex: number; chapterChanged: boolean } | null;
export function createReadingRequestGate(): {
  begin(chapterId: string): { chapterId: string; generation: number; signal: AbortSignal };
  isCurrent(request: { chapterId: string; generation: number; signal: AbortSignal }): boolean;
  finish(request: { chapterId: string; generation: number }): void;
  cancel(): void;
};
