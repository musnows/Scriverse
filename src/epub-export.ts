import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import sharp from "sharp";
import { createZipStream, type ZipStreamEntry } from "./zip-stream.js";

export const EPUB_MIME_TYPE = "application/epub+zip";

export type EpubExportChapter = {
  title: string;
  content: string | (() => string);
};

export type EpubExportVolume = {
  title: string;
  chapters: EpubExportChapter[];
};

export type EpubExportCover = {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  content: Buffer;
};

export type EpubExportInput = {
  title: string;
  author?: string;
  description?: string;
  language?: string;
  volumes: EpubExportVolume[];
  cover?: EpubExportCover | null;
  identifier?: string;
  modifiedAt?: string;
};

type PreparedCover = {
  content: Buffer;
  extension: "jpg" | "png";
  mediaType: "image/jpeg" | "image/png";
};

type EpubDocument = {
  id: string;
  href: string;
  title: string;
};

const bidiControlCharacters = /[\u202a-\u202e\u2066-\u2069]/gu;
const unsafeFileNameCharacters = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/gu;

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeLanguage(value: string | undefined): string {
  const language = String(value ?? "").trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language) ? language : "zh-CN";
}

function normalizeModifiedAt(value: string | undefined): { date: Date; value: string } {
  const parsed = value ? new Date(value) : new Date();
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return { date, value: date.toISOString().replace(/\.\d{3}Z$/u, "Z") };
}

function xhtmlPage(input: {
  language: string;
  title: string;
  body: string;
  bodyType?: string;
  stylePath?: string;
}): string {
  const bodyType = input.bodyType ? ` epub:type="${xml(input.bodyType)}"` : "";
  const stylePath = input.stylePath ?? "../styles/book.css";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${xml(input.language)}" xml:lang="${xml(input.language)}">
  <head>
    <meta charset="UTF-8" />
    <title>${xml(input.title)}</title>
    <link rel="stylesheet" type="text/css" href="${xml(stylePath)}" />
  </head>
  <body${bodyType}>
${input.body}
  </body>
</html>
`;
}

function renderChapterBody(content: string): string {
  const lines = String(content ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push(`    <p>${paragraph.map(xml).join("<br />\n")}</p>`);
    paragraph = [];
  };
  const flushCode = (): void => {
    if (code === null) return;
    blocks.push(`    <pre class="code-block"><code>${xml(code.join("\n"))}</code></pre>`);
    code = null;
  };

  for (const line of lines) {
    if (/^\s*`{3,}[^`]*$/u.test(line)) {
      if (code === null) {
        flushParagraph();
        code = [];
      } else {
        flushCode();
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushCode();
  return blocks.join("\n");
}

async function prepareCover(cover: EpubExportCover): Promise<PreparedCover> {
  if (cover.mimeType === "image/jpeg") {
    return { content: cover.content, extension: "jpg", mediaType: "image/jpeg" };
  }
  if (cover.mimeType === "image/png") {
    return { content: cover.content, extension: "png", mediaType: "image/png" };
  }
  return {
    content: await sharp(cover.content, { limitInputPixels: 16_777_216 }).png().toBuffer(),
    extension: "png",
    mediaType: "image/png"
  };
}

function packageDocument(input: {
  title: string;
  author: string;
  description: string;
  language: string;
  identifier: string;
  modifiedAt: string;
  documents: EpubDocument[];
  cover: PreparedCover | null;
}): string {
  const creator = input.author ? `\n    <dc:creator>${xml(input.author)}</dc:creator>` : "";
  const description = input.description ? `\n    <dc:description>${xml(input.description)}</dc:description>` : "";
  const coverMetadata = input.cover ? '\n    <meta name="cover" content="cover-image" />' : "";
  const coverManifest = input.cover
    ? `\n    <item id="cover-image" href="images/cover.${input.cover.extension}" media-type="${input.cover.mediaType}" properties="cover-image" />\n    <item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml" />`
    : "";
  const documentManifest = input.documents
    .map((document) => `    <item id="${document.id}" href="${document.href}" media-type="application/xhtml+xml" />`)
    .join("\n");
  const coverSpine = input.cover ? '\n    <itemref idref="cover-page" linear="no" />' : "";
  const documentSpine = input.documents.map((document) => `    <itemref idref="${document.id}" />`).join("\n");
  const guide = input.cover ? '\n  <guide>\n    <reference type="cover" title="封面" href="text/cover.xhtml" />\n  </guide>' : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="pub-id" xml:lang="${xml(input.language)}" prefix="dcterms: http://purl.org/dc/terms/">
  <metadata>
    <dc:identifier id="pub-id">${xml(input.identifier)}</dc:identifier>
    <dc:title>${xml(input.title)}</dc:title>
    <dc:language>${xml(input.language)}</dc:language>${creator}${description}
    <meta property="dcterms:modified">${xml(input.modifiedAt)}</meta>${coverMetadata}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="style" href="styles/book.css" media-type="text/css" />${coverManifest}
${documentManifest}
  </manifest>
  <spine toc="ncx">${coverSpine}
${documentSpine}
  </spine>${guide}
</package>
`;
}

function navigationDocument(input: {
  title: string;
  language: string;
  volumes: Array<{ document: EpubDocument; chapters: EpubDocument[] }>;
  hasCover: boolean;
}): string {
  const volumeContents = input.volumes.map(({ document, chapters }) => {
    const children = chapters.length
      ? `\n        <ol>\n${chapters.map((chapter) => `          <li><a href="${chapter.href}">${xml(chapter.title)}</a></li>`).join("\n")}\n        </ol>`
      : "";
    return `      <li><a href="${document.href}">${xml(document.title)}</a>${children}</li>`;
  }).join("\n");
  const contents = volumeContents || '      <li><a href="text/title.xhtml">书名页</a></li>';
  const coverLandmark = input.hasCover ? '\n        <li><a epub:type="cover" href="text/cover.xhtml">封面</a></li>' : "";
  const body = `    <nav epub:type="toc" id="toc" aria-labelledby="toc-title">
      <h1 id="toc-title">目录</h1>
      <ol>
${contents}
      </ol>
    </nav>
    <nav epub:type="landmarks" aria-label="阅读导航">
      <ol>${coverLandmark}
        <li><a epub:type="titlepage" href="text/title.xhtml">书名页</a></li>
        <li><a epub:type="bodymatter" href="${input.volumes[0]?.document.href ?? "text/title.xhtml"}">正文</a></li>
      </ol>
    </nav>`;
  return xhtmlPage({ language: input.language, title: `${input.title}目录`, body, stylePath: "styles/book.css" });
}

function ncxDocument(input: {
  title: string;
  identifier: string;
  volumes: Array<{ document: EpubDocument; chapters: EpubDocument[] }>;
}): string {
  let playOrder = 0;
  const volumeNavigation = input.volumes.map(({ document, chapters }) => {
    playOrder += 1;
    const volumeOrder = playOrder;
    const children = chapters.map((chapter) => {
      playOrder += 1;
      return `      <navPoint id="${chapter.id}" playOrder="${playOrder}">
        <navLabel><text>${xml(chapter.title)}</text></navLabel>
        <content src="${chapter.href}" />
      </navPoint>`;
    }).join("\n");
    return `    <navPoint id="${document.id}" playOrder="${volumeOrder}">
      <navLabel><text>${xml(document.title)}</text></navLabel>
      <content src="${document.href}" />${children ? `\n${children}` : ""}
    </navPoint>`;
  }).join("\n");
  const navigation = volumeNavigation || `    <navPoint id="title-page" playOrder="1">
      <navLabel><text>${xml(input.title)}</text></navLabel>
      <content src="text/title.xhtml" />
    </navPoint>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${xml(input.identifier)}" />
    <meta name="dtb:depth" content="2" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${xml(input.title)}</text></docTitle>
  <navMap>
${navigation}
  </navMap>
</ncx>
`;
}

const bookStyles = `@charset "UTF-8";
@namespace epub "http://www.idpf.org/2007/ops";
html { writing-mode: horizontal-tb; }
body { margin: 5%; color: #1f1f1f; font-family: serif; line-height: 1.8; }
h1 { margin: 1.5em 0 1em; font-size: 1.65em; line-height: 1.35; }
p { margin: 0 0 1em; text-align: justify; }
.title-page, .cover-page { min-height: 80vh; text-align: center; }
.title-page { display: flex; flex-direction: column; justify-content: center; }
.title-page p { text-align: center; }
.book-description { margin: 2em auto 0; max-width: 32em; color: #555; }
.cover-page img { display: block; max-width: 100%; max-height: 90vh; margin: 0 auto; object-fit: contain; }
.volume-label { color: #666; font-size: .85em; }
.code-block { margin: 1em 0; padding: .8em; overflow-wrap: anywhere; white-space: pre-wrap; font-family: monospace; font-size: .9em; line-height: 1.55; }
nav ol { padding-left: 1.5em; }
nav li { margin: .45em 0; }
nav[epub|type~="landmarks"] { margin-top: 2em; }
`;

export function epubDownloadFileName(title: string): string {
  const normalized = String(title ?? "")
    .normalize("NFKC")
    .replace(bidiControlCharacters, "")
    .replace(unsafeFileNameCharacters, " ")
    .replace(/\.{2,}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "");
  const stem = Array.from(normalized).slice(0, 120).join("") || "novel";
  return `${stem}.epub`;
}

function asciiFallbackFileName(value: string): string {
  const stem = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/\.{2,}/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 80) || "novel";
  return `${stem}.epub`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function epubContentDisposition(title: string, fallbackStem: string): string {
  return `attachment; filename="${asciiFallbackFileName(fallbackStem)}"; filename*=UTF-8''${encodeRfc5987(epubDownloadFileName(title))}`;
}

export async function createEpubArchive(input: EpubExportInput): Promise<Readable> {
  const title = String(input.title || "未命名作品");
  const author = String(input.author ?? "").trim();
  const description = String(input.description ?? "").trim();
  const language = normalizeLanguage(input.language);
  const identifier = String(input.identifier ?? `urn:uuid:${randomUUID()}`);
  const modified = normalizeModifiedAt(input.modifiedAt);
  const cover = input.cover ? await prepareCover(input.cover) : null;
  const entries: ZipStreamEntry[] = [{ name: "mimetype", content: EPUB_MIME_TYPE, compression: "STORE" }];
  entries.push({ name: "META-INF/container.xml", content: `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
` });
  entries.push({ name: "OEBPS/styles/book.css", content: bookStyles });

  if (cover) {
    entries.push({ name: `OEBPS/images/cover.${cover.extension}`, content: cover.content });
    entries.push({ name: "OEBPS/text/cover.xhtml", content: xhtmlPage({
      language,
      title: `${title}封面`,
      body: `    <div class="cover-page"><img src="../images/cover.${cover.extension}" alt="${xml(title)}封面" /></div>`,
      bodyType: "cover"
    }) });
  }

  const titleBody = `    <section class="title-page" epub:type="titlepage">
      <h1>${xml(title)}</h1>${author ? `\n      <p class="book-author">${xml(author)}</p>` : ""}${description ? `\n      <p class="book-description">${xml(description)}</p>` : ""}
    </section>`;
  const titleDocument: EpubDocument = {
    id: "title-page",
    href: "text/title.xhtml",
    title
  };
  entries.push({
    name: `OEBPS/${titleDocument.href}`,
    content: xhtmlPage({ language, title, body: titleBody, bodyType: "frontmatter" })
  });

  const volumeDocuments = input.volumes.map((volume, volumeIndex) => {
    const volumeNumber = String(volumeIndex + 1).padStart(3, "0");
    const volumeTitle = String(volume.title ?? "");
    const volumeDocument: EpubDocument = {
      id: `volume-${volumeNumber}`,
      href: `text/volume-${volumeNumber}.xhtml`,
      title: volumeTitle
    };
    entries.push({
      name: `OEBPS/${volumeDocument.href}`,
      content: xhtmlPage({
        language,
        title: volumeTitle,
        body: `    <section class="volume-page" epub:type="part"><h1>${xml(volumeTitle)}</h1></section>`,
        bodyType: "bodymatter"
      })
    });
    const chapters = volume.chapters.map((chapter, chapterIndex) => {
      const chapterNumber = String(chapterIndex + 1).padStart(3, "0");
      const chapterTitle = String(chapter.title ?? "");
      const chapterDocument: EpubDocument = {
        id: `chapter-${volumeNumber}-${chapterNumber}`,
        href: `text/chapter-${volumeNumber}-${chapterNumber}.xhtml`,
        title: chapterTitle
      };
      entries.push({
        name: `OEBPS/${chapterDocument.href}`,
        content: () => xhtmlPage({
          language,
          title: chapterTitle,
          body: `    <article epub:type="chapter">\n      <p class="volume-label">${xml(volumeTitle)}</p>\n      <h1>${xml(chapterTitle)}</h1>\n${renderChapterBody(typeof chapter.content === "function" ? chapter.content() : chapter.content)}\n    </article>`,
          bodyType: "bodymatter"
        })
      });
      return chapterDocument;
    });
    return { document: volumeDocument, chapters };
  });

  const documents = [titleDocument, ...volumeDocuments.flatMap((volume) => [volume.document, ...volume.chapters])];
  entries.push({ name: "OEBPS/nav.xhtml", content: navigationDocument({ title, language, volumes: volumeDocuments, hasCover: Boolean(cover) }) });
  entries.push({ name: "OEBPS/toc.ncx", content: ncxDocument({ title, identifier, volumes: volumeDocuments }) });
  entries.push({ name: "OEBPS/package.opf", content: packageDocument({
    title,
    author,
    description,
    language,
    identifier,
    modifiedAt: modified.value,
    documents,
    cover
  }) });
  return createZipStream(entries, modified.date);
}
