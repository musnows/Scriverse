import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

describe("种族共同设定界面", () => {
  it("完整渲染种族 Markdown 正文并保留组织摘要模式", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const rendererSource = sourceBetween(
      application,
      "function knowledgeSectionPreviewText(",
      "\nfunction bindDynamicListControls"
    );
    const section = {
      title: "生理特征",
      summary: "种族共同规律",
      contentMarkdown: "# 月裔\n\n**夜视能力**",
      sortOrder: 0
    };

    function render(kind: "race" | "organization") {
      const host = {
        innerHTML: "",
        querySelector: () => null,
        querySelectorAll: () => []
      };
      const renderedMarkdown: string[] = [];
      const context = {
        knowledgeEditorKind: kind,
        knowledgeEditorSections: [section],
        entityEditorReadOnly: true,
        canEditModule: () => false,
        esc: escapeHtml,
        $: () => host,
        renderMarkdown: (markdown: string) => {
          renderedMarkdown.push(markdown);
          return `<h1>${escapeHtml(markdown.split("\n")[0]?.replace(/^#\s*/u, ""))}</h1>`;
        }
      };
      const renderKnowledgeMarkdownSections = vm.runInNewContext(
        `${rendererSource}\nrenderKnowledgeMarkdownSections`,
        context
      ) as () => void;

      renderKnowledgeMarkdownSections();
      return { html: host.innerHTML, renderedMarkdown };
    }

    const race = render("race");
    expect(race.renderedMarkdown).toEqual([section.contentMarkdown]);
    expect(race.html).toContain('class="knowledge-markdown-document character-markdown-document message-body"');
    expect(race.html).toContain("<h1>月裔</h1>");
    expect(race.html).not.toContain("knowledge-section-card-preview");

    const organization = render("organization");
    expect(organization.renderedMarkdown).toEqual([]);
    expect(organization.html).toContain('class="knowledge-section-card-preview"');
    expect(organization.html).toContain("夜视能力");
    expect(organization.html).not.toContain("knowledge-markdown-document");
  });
});
