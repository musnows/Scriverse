export function tokenizeVisibleSpaces(value) {
  const tokens = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    tokens.push({ type: "text", text });
    text = "";
  };
  for (const character of String(value ?? "")) {
    if (character === " " || character === "\u3000") {
      flushText();
      tokens.push({ type: character === " " ? "space" : "ideographic-space", text: character });
    } else {
      text += character;
    }
  }
  flushText();
  return tokens;
}
