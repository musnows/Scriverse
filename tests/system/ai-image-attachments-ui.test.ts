import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("AI 对话图片附件界面", () => {
  it("提供多模态模型门禁、文件选择和剪贴板粘贴入口", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [application, page, styles] = await Promise.all([
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="ai-image-attachments" class="ai-image-attachments hidden"');
    expect(page).toContain('id="ai-attachment-button" class="ai-attachment-button hidden"');
    expect(page).toContain('id="ai-image-preview-dialog" class="dialog ai-image-preview-dialog"');
    expect(page).toContain('id="ai-image-preview-image"');
    expect(page).toContain('class="ai-image-button-icon"');
    expect(page).toContain('<rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect>');
    expect(page).toContain('<circle cx="9" cy="10" r="1.5"></circle>');
    expect(page).toContain('accept="image/png,image/jpeg,.jpg,.jpeg"');
    expect(application).toContain("function aiModelSupportsImageInput()");
    expect(application).toContain("function addAiImageFiles(files)");
    expect(application).toContain("function openAiImagePreview(attachment, ordinal = null)");
    expect(application).toContain("function appendAiMessageImageAttachments(message, attachments)");
    expect(application).toContain('preview.className = "ai-message-image-preview"');
    expect(application).toContain("openAiImagePreview(attachment, index + 1)");
    expect(application).toContain("label.textContent = `#${index + 1}`");
    expect(application).toContain('$("#ai-image-preview-title").textContent = Number.isInteger(ordinal) ? `#${ordinal} 图片预览` : "图片预览";');
    expect(application).toContain("assertAiChatImageFileSize(file)");
    expect(application).toContain("clipboardImageFiles(event.clipboardData)");
    expect(application).toContain("event.stopImmediatePropagation();");
    expect(application).toContain('toast("当前选择的模型不是多模态模型，无法粘贴图片附件", "error")');
    expect(application).toContain('module=ai-chat');
    expect(application).toContain("imageAttachmentIds");
    expect(application).toContain('toast("图片附件仅支持 PNG、JPG、JPEG", "error")');
    expect(application).toContain("imageUploadLimits.chatImageBytes");
    expect(styles).toContain(".ai-attachment-button { position: absolute; bottom: 8px; left: 8px;");
    expect(styles).toContain(".ai-image-attachment { display: inline-flex; flex: 0 0 auto;");
    expect(styles).toContain(".ai-image-attachment-preview { display: inline-flex; align-items: center;");
    expect(styles).toContain(".ai-image-attachment-label");
    expect(styles).toContain(".ai-image-attachment-remove { display: grid; flex: 0 0 17px;");
    expect(styles).toContain(".ai-image-attachments { display: flex; gap: 5px; max-height: 38px; margin-bottom: 6px;");
    expect(styles).toContain(".ai-image-preview-dialog { width: min(900px, 94vw);");
    expect(styles).toContain(".ai-message-image-preview { display: block; width: 68px; height: 68px;");
    expect(styles).toContain(".ai-image-button-icon { width: 17px; height: 17px;");
    expect(styles).toContain("border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--line));");
  });
});
