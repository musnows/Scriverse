function characterRaceId(character) {
  return String(character?.race?.id ?? character?.raceId ?? "");
}

function characterOrganizationIds(character) {
  return (Array.isArray(character?.organizations) ? character.organizations : [])
    .map((organization) => String(organization?.organizationId ?? organization?.id ?? ""))
    .filter(Boolean);
}

function characterGender(character) {
  const gender = String(character?.gender ?? "unknown");
  return ["male", "female", "none", "unknown"].includes(gender) ? gender : "unknown";
}

/**
 * @param {unknown[]} characters
 * @param {{ raceIds?: string[]; organizationIds?: string[]; genderValues?: string[]; deathState?: string }} [options]
 */
export function filterCharacters(characters, options = {}) {
  const { raceIds = [], organizationIds = [], genderValues = [], deathState = "all" } = options;
  const selectedRaceIds = new Set(raceIds.map(String).filter(Boolean));
  const selectedOrganizationIds = new Set(organizationIds.map(String).filter(Boolean));
  const selectedGenderValues = new Set(genderValues.map(String).filter(Boolean));
  const selectedDeathState = deathState === "alive" || deathState === "dead" ? deathState : "all";
  return characters.filter((character) => {
    const matchesRace = selectedRaceIds.size === 0 || selectedRaceIds.has(characterRaceId(character));
    const matchesOrganization = selectedOrganizationIds.size === 0
      || characterOrganizationIds(character).some((organizationId) => selectedOrganizationIds.has(organizationId));
    const matchesGender = selectedGenderValues.size === 0 || selectedGenderValues.has(characterGender(character));
    const matchesDeathState = selectedDeathState === "all"
      || (selectedDeathState === "dead" ? Boolean(character?.isDead) : !Boolean(character?.isDead));
    return matchesRace && matchesOrganization && matchesGender && matchesDeathState;
  });
}

export function paginateCharacters(characters, page, limit) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const safePage = Math.max(1, Number(page) || 1);
  const start = (safePage - 1) * safeLimit;
  const items = characters.slice(start, start + safeLimit);
  return {
    items,
    page: safePage,
    limit: safeLimit,
    hasMore: start + safeLimit < characters.length,
    nextPage: start + safeLimit < characters.length ? safePage + 1 : null,
    total: characters.length
  };
}
