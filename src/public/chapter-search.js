export function findTextMatches(value, query) {
  const source = String(value ?? "");
  const needle = String(query ?? "");
  if (!needle) return [];
  const matches = [];
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index < 0) return matches;
    matches.push(index);
    offset = index + needle.length;
  }
}

export function replaceTextMatches(value, query, replacement) {
  const source = String(value ?? "");
  const needle = String(query ?? "");
  const matches = findTextMatches(source, needle);
  return {
    content: matches.length ? source.replaceAll(needle, () => String(replacement ?? "")) : source,
    matches: matches.length
  };
}
