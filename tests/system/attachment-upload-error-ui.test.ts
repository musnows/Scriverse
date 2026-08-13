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

describe("图片附件上传错误提示", () => {
  it("将服务端 GIF 帧数错误通过统一错误链路显示为 toast", async () => {
    const application = await readFile(join(process.cwd(), "src/public/app.js"), "utf8");
    const clientErrorSource = sourceBetween(application, "function createClientError(", "\nfunction aiStreamInterruptionLabel");
    const uploadHandlerSource = sourceBetween(application, "function createVditorUploadHandler(", "\nfunction createVditorEditor");
    const shownToasts: Array<{ message: string; type: string }> = [];
    let placeholderFailed = false;
    const context = {
      createVditorUploadPlaceholder: () => ({
        update: () => undefined,
        complete: () => undefined,
        fail: () => { placeholderFailed = true; }
      }),
      normalizeVditorAttachmentImages: () => undefined,
      toast: (message: string, type: string) => shownToasts.push({ message, type }),
      window: { getSelection: () => null }
    };
    const functions = vm.runInNewContext(
      `(() => { ${clientErrorSource}\n${uploadHandlerSource}\nreturn { createClientError, createVditorUploadHandler }; })()`,
      context
    ) as {
      createClientError: (payload: unknown, fallbackMessage: string, status: number) => Error & { code?: string; status?: number };
      createVditorUploadHandler: (
        uploadAttachment: () => Promise<never>,
        getEditor: () => null
      ) => (files: Array<{ name: string }>) => Promise<null>;
    };
    const serverError = functions.createClientError({
      code: "ATTACHMENT_GIF_TOO_MANY_FRAMES",
      message: "GIF 动画不能超过 10,000 帧"
    }, "请求失败：413", 413);

    const handler = functions.createVditorUploadHandler(async () => { throw serverError; }, () => null);
    await handler([{ name: "超限动画.gif" }]);

    expect(serverError).toMatchObject({ code: "ATTACHMENT_GIF_TOO_MANY_FRAMES", status: 413 });
    expect(placeholderFailed).toBe(true);
    expect(shownToasts).toEqual([{ message: "GIF 动画不能超过 10,000 帧", type: "error" }]);
  });
});
