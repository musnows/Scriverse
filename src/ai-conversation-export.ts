type ExportRecord = Record<string, unknown>;

function recordValue(value: unknown): ExportRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ExportRecord : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function markdownInline(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_{}\[\]<>#+.!|])/gu, "\\$1");
}

function timestamp(value: unknown): string {
  const parsed = new Date(stringValue(value));
  return Number.isNaN(parsed.getTime()) ? "未知时间" : parsed.toISOString();
}

function safeFilenameTitle(value: unknown): string {
  const normalized = stringValue(value, "AI 对话")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>:"/\\|?*]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[.\s-]+|[.\s-]+$/gu, "");
  return Array.from(normalized || "AI 对话").slice(0, 80).join("");
}

function asciiIdentifier(value: unknown): string {
  return stringValue(value)
    .replace(/[^A-Za-z0-9_-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "export";
}

function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) => (
    `%${character.codePointAt(0)!.toString(16).toUpperCase()}`
  ));
}

export function aiConversationExportFilename(conversation: unknown): string {
  const record = recordValue(conversation);
  return `${safeFilenameTitle(record?.title)}-${asciiIdentifier(record?.id)}.md`;
}

export function aiConversationExportContentDisposition(conversation: unknown): string {
  const record = recordValue(conversation);
  const fallback = `ai-conversation-${asciiIdentifier(record?.id)}.md`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(aiConversationExportFilename(conversation))}`;
}

export function exportAiConversationMarkdown(conversation: unknown): string {
  const record = recordValue(conversation) ?? {};
  const title = stringValue(record.title, "AI 对话");
  const roleplayCharacter = recordValue(record.roleplayCharacter);
  const assistantLabel = stringValue(roleplayCharacter?.name, "助手") || "助手";
  const messages = Array.isArray(record.messages)
    ? record.messages.map(recordValue).filter((message): message is ExportRecord => message !== null)
    : [];
  const sections = [
    `# ${markdownInline(title)}`,
    "",
    `- 创建时间：${timestamp(record.createdAt)}`,
    `- 更新时间：${timestamp(record.updatedAt)}`,
    `- 消息数：${messages.length}`
  ];
  if (messages.length === 0) {
    sections.push("", "_暂无消息。_");
    return `${sections.join("\n")}\n`;
  }
  for (const message of messages) {
    const role = message.role === "user" ? "作者" : assistantLabel;
    const content = stringValue(message.content);
    sections.push(
      "",
      "---",
      "",
      `## ${markdownInline(role)} · ${timestamp(message.createdAt)}`,
      "",
      content
    );
  }
  return `${sections.join("\n")}\n`;
}
