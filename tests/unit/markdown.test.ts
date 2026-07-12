import { describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { renderMarkdown } from "../../src/public/markdown.js";

describe("侧边栏 Markdown 渲染", () => {
  it("渲染标题、强调、列表、链接和代码块", () => {
    const html = renderMarkdown("## 作品信息\n\n**类型**：科幻\n\n- 星际探索\n- 新角色\n\n[资料](https://example.com)\n\n```js\nconst answer = 42;\n```");
    expect(html).toContain("<h2>作品信息</h2>");
    expect(html).toContain("<strong>类型</strong>");
    expect(html).toContain("<ul><li");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<pre><code class="language-js">const answer = 42;</code></pre>');
  });

  it("转义 HTML 并拒绝脚本链接", () => {
    const html = renderMarkdown('<script>alert("x")</script>\n\n[危险](javascript:alert(1))');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
});
