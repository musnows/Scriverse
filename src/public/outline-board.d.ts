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
  chapters?: T[];
};

export type OutlineBoard<T extends OutlineBoardChapter = OutlineBoardChapter> = {
  volumes?: Array<OutlineBoardVolume<T>>;
};

export type OutlineBoardState = {
  query: string;
  volumeId: string;
  outlineStatus: "all" | "empty" | "draft" | "ready" | "completed";
  foreshadowStatus: "all" | "none" | "unresolved" | "resolved" | "abandoned";
  sort: "tree" | "status" | "foreshadows" | "title";
};

export declare function normalizeOutlineBoardState(value?: Partial<OutlineBoardState>): OutlineBoardState;

export declare function prepareOutlineBoard<T extends OutlineBoardChapter>(
  board: OutlineBoard<T> | null | undefined,
  value?: Partial<OutlineBoardState>
): {
  state: OutlineBoardState;
  volumes: Array<OutlineBoardVolume<T> & { chapters: T[] }>;
  totalChapterCount: number;
  visibleChapterCount: number;
  filtersActive: boolean;
};

export declare function outlineBoardUnresolvedCount(chapter: OutlineBoardChapter): number;
