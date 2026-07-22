import { AppError } from "./errors.js";

export type Pagination = {
  page: number;
  limit: number;
  offset: number;
};

export type PaginatedResult<T> = {
  items: T[];
  page: number;
  limit: number;
  hasMore: boolean;
  nextPage: number | null;
};

function queryValue(query: unknown, key: string): unknown {
  if (!query || typeof query !== "object") return undefined;
  return (query as Record<string, unknown>)[key];
}

function positiveInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new AppError(400, "INVALID_PAGINATION", `${field} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new AppError(400, "INVALID_PAGINATION", `${field} 超出允许范围`);
  }
  return parsed;
}

export function parsePagination(query: unknown): Pagination | undefined {
  const pageValue = queryValue(query, "page");
  const limitValue = queryValue(query, "limit");
  if (pageValue === undefined && limitValue === undefined) return undefined;
  if (Array.isArray(pageValue) || Array.isArray(limitValue)) {
    throw new AppError(400, "INVALID_PAGINATION", "分页参数不能重复传入");
  }
  const page = pageValue === undefined ? 1 : positiveInteger(pageValue, "page", 100_000);
  const limit = limitValue === undefined ? 50 : positiveInteger(limitValue, "limit", 100);
  return { page, limit, offset: (page - 1) * limit };
}

export function paginationSql(pagination: Pagination): { sql: string; params: [number, number] } {
  return { sql: " LIMIT ? OFFSET ?", params: [pagination.limit + 1, pagination.offset] };
}

export function paginated<T>(items: T[], pagination: Pagination): PaginatedResult<T> {
  const hasMore = items.length > pagination.limit;
  return {
    items: hasMore ? items.slice(0, pagination.limit) : items,
    page: pagination.page,
    limit: pagination.limit,
    hasMore,
    nextPage: hasMore ? pagination.page + 1 : null
  };
}
