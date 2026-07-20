const relationshipKeywordSeparator = /[,，、；;\n]/u;

function normalizeRelationshipKeyword(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function splitRelationshipKeywords(value) {
  return String(value ?? "")
    .split(relationshipKeywordSeparator)
    .map(normalizeRelationshipKeyword)
    .filter(Boolean);
}

export function uniqueRelationshipKeywords(values) {
  const keywords = [];
  const seen = new Set();
  for (const value of values) {
    for (const keyword of splitRelationshipKeywords(value)) {
      const key = keyword.toLocaleLowerCase("zh-CN");
      if (seen.has(key)) continue;
      seen.add(key);
      keywords.push(keyword);
    }
  }
  return keywords;
}

export function splitRelationshipKeywordInput(value) {
  const parts = String(value ?? "").split(relationshipKeywordSeparator);
  return {
    completed: uniqueRelationshipKeywords(parts.slice(0, -1)),
    remainder: parts.at(-1) ?? ""
  };
}
