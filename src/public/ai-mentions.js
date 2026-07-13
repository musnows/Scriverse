export function findAiMention(value, cursor = value.length) {
  const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, value.length));
  const match = value.slice(0, safeCursor).match(/@([^@\s]*)$/u);
  if (!match) return null;
  return {
    start: safeCursor - match[0].length,
    end: safeCursor,
    query: match[1]
  };
}

export function listAiMentionOptions(characters, settings, query = "", limit = 12) {
  const keyword = String(query).trim().toLocaleLowerCase("zh-CN");
  const options = [
    ...characters.map((item) => ({ kind: "character", kindLabel: "角色", id: String(item.id), name: String(item.name) })),
    ...settings.map((item) => ({ kind: "setting", kindLabel: "设定", id: String(item.id), name: String(item.title) }))
  ];
  return options
    .filter((item) => !keyword || item.name.toLocaleLowerCase("zh-CN").includes(keyword))
    .slice(0, Math.max(1, Number(limit) || 12));
}

export function applyAiMention(value, mention, name) {
  const token = `@${String(name).trim()}`;
  const text = `${value.slice(0, mention.start)}${token} ${value.slice(mention.end)}`;
  return { text, token, cursor: mention.start + token.length + 1 };
}

export function buildAiReferenceScope(references) {
  const characterIds = [...new Set(references.filter((item) => item.kind === "character").map((item) => item.id))];
  const settingIds = [...new Set(references.filter((item) => item.kind === "setting").map((item) => item.id))];
  return {
    ...(characterIds.length ? { characterIds } : {}),
    ...(settingIds.length ? { settingIds } : {})
  };
}
