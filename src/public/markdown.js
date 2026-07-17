const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/gu, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
})[character]);

function safeLinkTarget(value) {
  const target = String(value ?? "").trim();
  if (/^(https?:|mailto:)/iu.test(target)) return target;
  if (/^(\/|#)/u.test(target) && !target.startsWith("//")) return target;
  return null;
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const preserve = (html) => {
    const marker = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return marker;
  };
  let source = String(value ?? "");
  source = source.replace(/`([^`\n]+)`/gu, (_match, code) => preserve(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (_match, label, href) => {
    const target = safeLinkTarget(href);
    if (!target) return `${label}（${href}）`;
    const external = /^https?:/iu.test(target) ? ' target="_blank" rel="noopener noreferrer"' : "";
    return preserve(`<a href="${escapeHtml(target)}"${external}>${escapeHtml(label)}</a>`);
  });
  let html = escapeHtml(source);
  html = html.replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+)__/gu, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/gu, "$1<em>$2</em>");
  html = html.replace(/~~([^~\n]+)~~/gu, "<del>$1</del>");
  tokens.forEach((token, index) => {
    html = html.replace(`\uE000${index}\uE001`, token);
  });
  return html;
}

function splitMarkdownTableRow(value) {
  const source = String(value ?? "").trim();
  if (!source.includes("|")) return null;
  const cells = [];
  let cell = "";
  let inCode = false;
  let separators = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") inCode = !inCode;
    if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      separators += 1;
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  if (!separators) return null;
  if (source.startsWith("|")) cells.shift();
  if (source.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function tableAlignments(cells) {
  if (!cells?.length || !cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) return null;
  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function renderMarkdownTable(headers, alignments, rows) {
  const renderCell = (tag, value, alignment) => `<${tag} class="markdown-align-${alignment}">${renderInlineMarkdown(value)}</${tag}>`;
  const header = headers.map((cell, index) => renderCell("th", cell, alignments[index])).join("");
  const body = rows.map((row) => {
    const cells = headers.map((_header, index) => renderCell("td", row[index] ?? "", alignments[index])).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0"><table><thead><tr>${header}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
}

export function renderMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = null;
  let quote = null;
  let codeFence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    output.push(`<${list.tag}>${list.items.map((item) => `<li class="markdown-depth-${item.depth}">${renderInlineMarkdown(item.text)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    const content = quote.join("\n").trim();
    if (content) {
      const html = content.split(/\n\s*\n/gu)
        .map((part) => part.split("\n").map(renderInlineMarkdown).join("<br>"))
        .join("<br><br>");
      output.push(`<blockquote>${html}</blockquote>`);
    }
    quote = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (codeFence) {
      if (/^\s*```/u.test(line)) {
        output.push(`<pre><code${codeFence.language ? ` class="language-${codeFence.language}"` : ""}>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
        codeFence = null;
      } else {
        codeFence.lines.push(line);
      }
      continue;
    }
    const fence = line.match(/^\s*```([\w-]*)\s*$/u);
    if (fence) {
      flushBlocks();
      codeFence = { language: fence[1].replace(/[^\w-]/gu, ""), lines: [] };
      continue;
    }
    const quoteLine = line.match(/^>\s?(.*)$/u);
    if (quoteLine) {
      flushParagraph();
      flushList();
      if (!quote) quote = [];
      quote.push(quoteLine[1]);
      continue;
    }
    flushQuote();
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/u);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/u.test(line)) {
      flushBlocks();
      output.push("<hr>");
      continue;
    }
    const tableHeaders = splitMarkdownTableRow(line);
    const alignments = tableAlignments(splitMarkdownTableRow(lines[lineIndex + 1]));
    if (tableHeaders && alignments && tableHeaders.length === alignments.length) {
      flushBlocks();
      const rows = [];
      lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].trim()) {
        const row = splitMarkdownTableRow(lines[lineIndex]);
        if (!row) break;
        rows.push(row);
        lineIndex += 1;
      }
      lineIndex -= 1;
      output.push(renderMarkdownTable(tableHeaders, alignments, rows));
      continue;
    }
    const listItem = line.match(/^(\s*)([-+*]|\d+\.)\s+(.+)$/u);
    if (listItem) {
      flushParagraph();
      const tag = /\d+\./u.test(listItem[2]) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push({ depth: Math.min(3, Math.floor(listItem[1].length / 2)), text: listItem[3] });
      continue;
    }
    if (list) flushList();
    paragraph.push(line);
  }
  if (codeFence) output.push(`<pre><code${codeFence.language ? ` class="language-${codeFence.language}"` : ""}>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
  flushBlocks();
  return output.join("");
}
