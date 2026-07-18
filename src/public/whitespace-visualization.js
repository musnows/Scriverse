export function tokenizeVisibleSpaces(value) {
  const tokens = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    tokens.push({ type: "text", text });
    text = "";
  };
  for (const character of String(value ?? "")) {
    if (character === " " || character === "\u3000" || character === "\t") {
      flushText();
      const type = character === " " ? "space" : character === "\u3000" ? "ideographic-space" : "tab";
      tokens.push({ type, text: character });
    } else {
      text += character;
    }
  }
  flushText();
  return tokens;
}
