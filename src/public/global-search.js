const entityTargets = Object.freeze({
  setting: Object.freeze({ module: "settings", entity: "setting", resource: "settings" }),
  character: Object.freeze({ module: "characters", entity: "character", resource: "characters" }),
  race: Object.freeze({ module: "races", entity: "race", resource: "races" }),
  organization: Object.freeze({ module: "organizations", entity: "organization", resource: "organizations" }),
  "timeline-track": Object.freeze({ module: "timeline", entity: "timeline-track", resource: "timeline-tracks" }),
  "timeline-event": Object.freeze({ module: "timeline", entity: "timeline-event", resource: "timeline" }),
  relationship: Object.freeze({ module: "relationships", entity: "relationship", resource: "relationships" }),
  "chapter-outline": Object.freeze({ module: "outlines", entity: "chapter-outline", resource: "chapters", suffix: "outline" }),
  foreshadow: Object.freeze({ module: "outlines", entity: "foreshadow", resource: "foreshadows" }),
  review: Object.freeze({ module: "reviews", entity: "review", resource: "reviews" })
});

export function prioritizeGlobalSearchResults(results = []) {
  const settingResults = [];
  const proseResults = [];
  for (const result of Array.isArray(results) ? results : []) {
    (String(result?.type ?? "") === "chapter" ? proseResults : settingResults).push(result);
  }
  return [...settingResults, ...proseResults];
}

function positiveLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : null;
}

export function splitGlobalSearchHighlight(value, query) {
  const text = String(value ?? "");
  const needle = String(query ?? "").trim();
  if (!text || !needle) return text ? [{ text, match: false }] : [];
  const lowerText = text.toLocaleLowerCase("zh-CN");
  const lowerNeedle = needle.toLocaleLowerCase("zh-CN");
  const segments = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lowerText.indexOf(lowerNeedle, cursor);
    if (index < 0) break;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length ? segments : [{ text, match: false }];
}

export function resolveGlobalSearchTarget(result = {}) {
  const type = String(result.type ?? "").trim();
  const id = String(result.id ?? "").trim();
  if (!id) return null;
  if (type === "chapter") {
    const startLine = positiveLine(result.startLine);
    const endLine = positiveLine(result.endLine);
    return {
      kind: "chapter",
      type,
      id,
      module: "editor",
      ...(startLine ? { startLine, endLine: endLine && endLine >= startLine ? endLine : startLine } : {})
    };
  }
  const target = entityTargets[type];
  if (!target) return null;
  const encodedId = encodeURIComponent(id);
  return {
    kind: "entity",
    type,
    id,
    module: target.module,
    entity: target.entity,
    apiPath: `/api/${target.resource}/${encodedId}${target.suffix ? `/${target.suffix}` : ""}`
  };
}
