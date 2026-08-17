import { describe, expect, it } from "vitest";
import { filterCharacters, paginateCharacters } from "../../src/public/character-filters.js";

describe("character filters", () => {
  const characters = [
    { id: "a", race: { id: "r1" }, organizations: [{ organizationId: "o1" }], gender: "male", isDead: false },
    { id: "b", race: { id: "r2" }, organizations: [{ organizationId: "o1" }, { id: "o2" }], gender: "female", isDead: true },
    { id: "c", race: { id: "r1" }, organizations: [], gender: "none", isDead: false },
    { id: "d", race: null, organizations: [{ id: "o2" }], gender: "unknown", isDead: true }
  ];

  it("matches any selected value within a filter and all active filter groups", () => {
    expect(filterCharacters(characters, { raceIds: ["r1", "r2"] }).map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(filterCharacters(characters, { organizationIds: ["o2"] }).map((item) => item.id)).toEqual(["b", "d"]);
    expect(filterCharacters(characters, { raceIds: ["r1"], organizationIds: ["o1"] }).map((item) => item.id)).toEqual(["a"]);
  });

  it("按性别多选和死亡状态组合筛选", () => {
    expect(filterCharacters(characters, { genderValues: ["female", "unknown"] }).map((item) => item.id)).toEqual(["b", "d"]);
    expect(filterCharacters(characters, { genderValues: ["male", "none"], deathState: "alive" }).map((item) => item.id)).toEqual(["a", "c"]);
    expect(filterCharacters(characters, { deathState: "dead" }).map((item) => item.id)).toEqual(["b", "d"]);
    expect(filterCharacters(characters, { deathState: "alive" }).map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("returns all characters when no filter is selected", () => {
    expect(filterCharacters(characters)).toEqual(characters);
  });

  it("paginates the already-filtered result set", () => {
    expect(paginateCharacters(characters.slice(0, 3), 2, 2)).toMatchObject({ items: [{ id: "c" }], page: 2, hasMore: false, total: 3 });
  });
});
