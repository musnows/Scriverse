import { describe, expect, it } from "vitest";
import { filterRelationships, sortCharacterRelationships } from "../../src/public/relationship-filters.js";

describe("relationship filters", () => {
  const relationships = [
    { id: "r1", fromCharacterId: "a", toCharacterId: "b" },
    { id: "r2", fromCharacterId: "a", toCharacterId: "c" },
    { id: "r3", fromCharacterId: "b", toCharacterId: "c" },
    { id: "r4", fromCharacterId: "c", toCharacterId: "a" }
  ];

  it("matches any selected character within a filter and all active filter groups", () => {
    expect(filterRelationships(relationships, { fromCharacterIds: ["a", "b"] }).map((item) => item.id)).toEqual(["r1", "r2", "r3"]);
    expect(filterRelationships(relationships, { toCharacterIds: ["a", "c"] }).map((item) => item.id)).toEqual(["r2", "r3", "r4"]);
    expect(filterRelationships(relationships, { fromCharacterIds: ["a"], toCharacterIds: ["c"] }).map((item) => item.id)).toEqual(["r2"]);
  });

  it("returns all relationships when no filter is selected", () => {
    expect(filterRelationships(relationships)).toEqual(relationships);
  });

  it("groups the same other character before applying the stable detail order", () => {
    const characterRelationships = [
      { id: "r1", fromCharacterId: "self", toCharacterId: "b", confidence: 1, createdAt: "2026-01-01T00:00:00Z" },
      { id: "r2", fromCharacterId: "self", toCharacterId: "a", confidence: 0.1, createdAt: "2026-01-03T00:00:00Z" },
      { id: "r3", fromCharacterId: "c", toCharacterId: "self", confidence: 0.9, createdAt: "2026-01-02T00:00:00Z" },
      { id: "r4", fromCharacterId: "self", toCharacterId: "b", confidence: 0.9, createdAt: "2026-01-02T00:00:00Z" }
    ];

    expect(sortCharacterRelationships(characterRelationships, "self").map((item) => item.id)).toEqual(["r2", "r1", "r4", "r3"]);
    expect(characterRelationships.map((item) => item.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });
});
