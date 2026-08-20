import { describe, expect, it } from "vitest";

import { attachmentDownloadFileName, inlineContentDisposition } from "../../src/attachment-download.js";

describe("attachment download naming", () => {
  it("uses the context name and original image name", () => {
    expect(attachmentDownloadFileName("带图设定", "世界观图.png")).toBe("scriverse-带图设定-世界观图.png");
  });

  it("sanitizes unsafe filename characters and keeps unicode in the encoded header", () => {
    const fileName = attachmentDownloadFileName("角色/设定", "图:像?.png");
    const contentDisposition = inlineContentDisposition(fileName);

    expect(fileName).toBe("scriverse-角色-设定-图-像-.png");
    expect(contentDisposition).toContain("inline;");
    expect(contentDisposition).toContain("filename*=UTF-8''scriverse-%E8%A7%92%E8%89%B2-%E8%AE%BE%E5%AE%9A-%E5%9B%BE-%E5%83%8F-.png");
  });
});
