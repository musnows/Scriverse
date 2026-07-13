export function formatAiMessageMeta(modelDisplayName, outputTokens, suffix = "") {
  const modelName = String(modelDisplayName || "模型").trim();
  const tokenCount = Math.max(0, Math.round(Number(outputTokens) || 0)).toLocaleString("zh-CN");
  return [modelName, `${tokenCount} tok`, String(suffix || "").trim()].filter(Boolean).join(" · ");
}

export function estimateAiMessageTokens(value) {
  let wideCharacters = 0;
  let narrowCharacters = 0;
  for (const character of String(value || "")) {
    if (/[^\u0000-\u00ff]/u.test(character)) wideCharacters += 1;
    else narrowCharacters += 1;
  }
  return Math.max(1, Math.ceil(wideCharacters * 1.1 + narrowCharacters / 4));
}
