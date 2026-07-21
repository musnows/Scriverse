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

  it("渲染单反引号与双反引号行内代码", () => {
    const html = renderMarkdown("`单反引号` 与 ``包含 ` 的代码``，以及 ``222222`` 我喜欢你");

    expect(html).toContain("<code>单反引号</code>");
    expect(html).toContain("<code>包含 ` 的代码</code>");
    expect(html).toContain("<code>222222</code> 我喜欢你");
    expect(html).not.toContain("``222222``");
  });

  it("将连续引用行合并为一个引用块", () => {
    const html = renderMarkdown('> "第一句"\n>\n> "第二句"\n> "第三句"');

    expect(html).toBe('<blockquote>&quot;第一句&quot;<br><br>&quot;第二句&quot;<br>&quot;第三句&quot;</blockquote>');
    expect(html.match(/<blockquote>/gu)).toHaveLength(1);
    expect(html).not.toContain("<blockquote></blockquote>");
  });

  it("渲染带对齐方式的表格并保留单元格内的管道符", () => {
    const html = renderMarkdown("| 章节 | 标题 | 内容摘要 |\n| :--- | :---: | ---: |\n| 第一百六十三章 | **护盾实验** | `能量 | 护盾` |\n| 第一百六十四章 | 海洋星舰 | 哥斯拉\\|机械哥斯拉 | ");

    expect(html).toContain('<div class="markdown-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0">');
    expect(html).toContain('<th class="markdown-align-left">章节</th>');
    expect(html).toContain('<th class="markdown-align-center">标题</th>');
    expect(html).toContain('<td class="markdown-align-center"><strong>护盾实验</strong></td>');
    expect(html).toContain('<td class="markdown-align-right"><code>能量 | 护盾</code></td>');
    expect(html).toContain('<td class="markdown-align-right">哥斯拉|机械哥斯拉</td>');
  });

  it("转义表格单元格中的 HTML", () => {
    const html = renderMarkdown("| 名称 | 内容 |\n| --- | --- |\n| 测试 | <img src=x onerror=alert(1)> |");

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });

  it("渲染内部附件图片并拒绝不安全图片地址", () => {
    const html = renderMarkdown("###### 档案图\n\n![魔克拉](attachment://attachment_safe-1)\n\n![危险](javascript:alert(1))");

    expect(html).toContain("<h6>档案图</h6>");
    expect(html).toContain('src="/api/attachments/attachment_safe-1/content"');
    expect(html).toContain('alt="魔克拉"');
    expect(html).not.toContain('src="javascript:');
  });
});
