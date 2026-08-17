export function filterRelationships(relationships, { fromCharacterIds = [], toCharacterIds = [] } = {}) {
  const selectedFromCharacterIds = new Set(fromCharacterIds.map(String).filter(Boolean));
  const selectedToCharacterIds = new Set(toCharacterIds.map(String).filter(Boolean));
  return relationships.filter((relationship) => {
    const matchesFromCharacter = selectedFromCharacterIds.size === 0
      || selectedFromCharacterIds.has(String(relationship?.fromCharacterId ?? ""));
    const matchesToCharacter = selectedToCharacterIds.size === 0
      || selectedToCharacterIds.has(String(relationship?.toCharacterId ?? ""));
    return matchesFromCharacter && matchesToCharacter;
  });
}

function compareRelationshipText(left, right) {
  const leftText = String(left ?? "");
  const rightText = String(right ?? "");
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function compareRelationshipDetails(left, right) {
  const confidenceDifference = Number(right?.confidence ?? 0) - Number(left?.confidence ?? 0);
  if (confidenceDifference !== 0) return confidenceDifference;
  return compareRelationshipText(left?.createdAt, right?.createdAt)
    || compareRelationshipText(left?.id, right?.id);
}

export function sortCharacterRelationships(relationships, characterId) {
  const currentCharacterId = String(characterId ?? "");
  return [...relationships].sort((left, right) => {
    const leftFromCharacterId = String(left?.fromCharacterId ?? "");
    const rightFromCharacterId = String(right?.fromCharacterId ?? "");
    const leftOtherCharacterId = leftFromCharacterId === currentCharacterId
      ? String(left?.toCharacterId ?? "")
      : leftFromCharacterId;
    const rightOtherCharacterId = rightFromCharacterId === currentCharacterId
      ? String(right?.toCharacterId ?? "")
      : rightFromCharacterId;
    return compareRelationshipText(leftOtherCharacterId, rightOtherCharacterId)
      || compareRelationshipDetails(left, right);
  });
}
