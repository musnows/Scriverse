import { describe, expect, it } from "vitest";
import { parsePagination, paginated } from "../../src/pagination.js";

describe("pagination", () => {
  it("uses bounded defaults when pagination is requested", () => {
    expect(parsePagination({ limit: "2" })).toEqual({ page: 1, limit: 2, offset: 0 });
    expect(parsePagination({ page: "3", limit: "2" })).toEqual({ page: 3, limit: 2, offset: 4 });
  });

  it("returns the next page only when an extra row exists", () => {
    expect(paginated([1, 2, 3], { page: 1, limit: 2, offset: 0 })).toEqual({
      items: [1, 2],
      page: 1,
      limit: 2,
      hasMore: true,
      nextPage: 2
    });
    expect(paginated([1], { page: 2, limit: 2, offset: 2 })).toMatchObject({ items: [1], hasMore: false, nextPage: null });
  });
});
