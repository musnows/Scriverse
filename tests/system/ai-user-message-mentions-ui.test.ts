import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 用户消息角色引用横幅", () => {
  it("透传流式消息 metadata 并渲染可换行的角色标签", async () => {
    const [page, application, styles] = await Promise.all([
      readFile(join(process.cwd(), "src", "public", "index.html"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "app.js"), "utf8"),
      readFile(join(process.cwd(), "src", "public", "styles.css"), "utf8")
    ]);

    expect(page).toContain('/styles.css?v=20260812-ai-conversation-export-mobile-foreshadow-epub-v1');
    expect(page).toContain('/app.js?v=20260812-ai-stream-connectivity-global-replace-foreshadow-epub-v1');
    expect(application).toContain('/ai-mentions.js?v=20260811-user-message-mentions-v1');
    expect(application).toContain("persistedUserMessage.createdAt, persistedUserMessage.metadata, persistedUserMessage.id");
    expect(application).toContain("userMessageMentionNames(metadata?.mentionCharacterIds, state.characters)");
    expect(application).toContain("ensureAiReferencesLoaded()\n    ]);");
    expect(application).toContain('references.className = "user-message-mentions";');
    expect(application).toContain('label.textContent = "引用角色";');
    expect(styles).toContain(".user-message-mentions { display: flex; align-items: center; flex-wrap: wrap;");
    expect(styles).toContain(".user-message-mention { min-width: 0; max-width: 100%;");
  });
});
