import { describe, expect, it } from "vitest";
import {
  TIMELINE_UNGROUPED_COLOR_INDEX,
  filterTimelineEvents,
  prepareTimelineEvents,
  sortTimelineEvents,
  timelineTrackColorIndex,
  timelineTrackDisplayName
} from "../../src/public/timeline-view.js";

describe("sortTimelineEvents", () => {
  it("sorts by timeSort ascending and places missing sorts last", () => {
    const events = [
      { id: "c", timeSort: 30, updatedAt: "2026-01-03" },
      { id: "a", timeSort: 10, updatedAt: "2026-01-01" },
      { id: "missing", timeSort: null, updatedAt: "2026-01-04" },
      { id: "b", timeSort: 20, updatedAt: "2026-01-02" },
      { id: "undefined-sort", updatedAt: "2026-01-05" }
    ];
    expect(sortTimelineEvents(events).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
      "missing",
      "undefined-sort"
    ]);
  });

  it("breaks ties by updatedAt then id", () => {
    const events = [
      { id: "b", timeSort: 1, updatedAt: "2026-01-02" },
      { id: "a", timeSort: 1, updatedAt: "2026-01-01" },
      { id: "c", timeSort: 1, updatedAt: "2026-01-02" }
    ];
    expect(sortTimelineEvents(events).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("filterTimelineEvents", () => {
  const events = [
    { id: "e1", trackId: "main" },
    { id: "e2", trackId: "side" },
    { id: "e3", trackId: null },
    { id: "e4", trackId: "" }
  ];

  it("returns all events when no track filter is selected", () => {
    expect(filterTimelineEvents(events)).toEqual(events);
    expect(filterTimelineEvents(events, { trackIds: [] })).toEqual(events);
  });

  it("filters by selected track ids including ungrouped empty string", () => {
    expect(filterTimelineEvents(events, { trackIds: ["main"] }).map((item) => item.id)).toEqual(["e1"]);
    expect(filterTimelineEvents(events, { trackIds: [""] }).map((item) => item.id)).toEqual(["e3", "e4"]);
    expect(filterTimelineEvents(events, { trackIds: ["main", ""] }).map((item) => item.id)).toEqual(["e1", "e3", "e4"]);
  });
});

describe("timelineTrackColorIndex", () => {
  const tracks = [
    { id: "b", sortOrder: 2 },
    { id: "a", sortOrder: 1 },
    { id: "c", sortOrder: 3 }
  ];

  it("maps tracks by sortOrder and uses a fixed index for ungrouped", () => {
    expect(timelineTrackColorIndex("a", tracks)).toBe(0);
    expect(timelineTrackColorIndex("b", tracks)).toBe(1);
    expect(timelineTrackColorIndex("c", tracks)).toBe(2);
    expect(timelineTrackColorIndex("", tracks)).toBe(TIMELINE_UNGROUPED_COLOR_INDEX);
    expect(timelineTrackColorIndex(null, tracks)).toBe(TIMELINE_UNGROUPED_COLOR_INDEX);
    expect(timelineTrackColorIndex("missing", tracks)).toBe(TIMELINE_UNGROUPED_COLOR_INDEX);
  });
});

describe("prepareTimelineEvents", () => {
  it("filters then sorts chronologically", () => {
    const events = [
      { id: "side-late", trackId: "side", timeSort: 20, updatedAt: "2026-01-02" },
      { id: "main-early", trackId: "main", timeSort: 5, updatedAt: "2026-01-01" },
      { id: "main-late", trackId: "main", timeSort: 15, updatedAt: "2026-01-03" },
      { id: "ungrouped", trackId: null, timeSort: 1, updatedAt: "2026-01-04" }
    ];
    expect(prepareTimelineEvents(events, { trackIds: ["main"] }).map((item) => item.id)).toEqual([
      "main-early",
      "main-late"
    ]);
  });
});

describe("timelineTrackDisplayName", () => {
  it("resolves track names and ungrouped label", () => {
    const tracks = [{ id: "main", name: "主线时间轴" }];
    expect(timelineTrackDisplayName("main", tracks)).toBe("主线时间轴");
    expect(timelineTrackDisplayName("", tracks)).toBe("未分组");
    expect(timelineTrackDisplayName("missing", tracks)).toBe("未知轨道");
  });
});
