export type OutlineBoardForeshadow = {
  id?: string | null;
  title?: string | null;
  status?: string | null;
  importance?: string | null;
  roles?: string[];
  plannedPayoff?: boolean;
};

export type OutlineBoardOutline = {
  goal?: string | null;
  conflict?: string | null;
  turningPoint?: string | null;
  notes?: string | null;
  status?: string | null;
  truncated?: boolean;
  updatedAt?: string | null;
};

export type OutlineBoardChapter = {
  id?: string | null;
  title?: string | null;
  chapterType?: string | null;
  sortOrder?: number | null;
  outline?: OutlineBoardOutline | null;
  foreshadows?: OutlineBoardForeshadow[];
};

export type OutlineBoardVolume<T extends OutlineBoardChapter = OutlineBoardChapter> = {
  id?: string | null;
  title?: string | null;
  sortOrder?: number | null;
  chapterCount?: number | null;
  filteredChapterCount?: number | null;
  chapters?: T[];
};

export type OutlineBoard<T extends OutlineBoardChapter = OutlineBoardChapter> = {
  volumes?: Array<OutlineBoardVolume<T>>;
  volumeOptions?: Array<Omit<OutlineBoardVolume<T>, "chapters">>;
  page?: number;
  limit?: number;
  itemCount?: number;
  total?: number;
  pageCount?: number;
  hasMore?: boolean;
  nextPage?: number | null;
};

export type OutlineBoardState = {
  query: string;
  volumeId: string;
  outlineStatus: "all" | "empty" | "draft" | "ready" | "completed";
  foreshadowStatus: "all" | "none" | "unresolved" | "resolved" | "abandoned";
  sort: "tree" | "status" | "foreshadows" | "title";
};

export declare function normalizeOutlineBoardState(value?: Partial<OutlineBoardState>): OutlineBoardState;

export declare function outlineBoardRequestPath(
  workId: string,
  value?: Partial<OutlineBoardState>,
  page?: number,
  limit?: number
): string;

export declare function outlineBoardUnresolvedCount(chapter: OutlineBoardChapter): number;
