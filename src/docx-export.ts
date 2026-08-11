import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  TextRun
} from "docx";
import sharp from "sharp";
import { readRasterImageMetadata } from "./image-metadata.js";

export type DocxExportChapter = {
  title: string;
  content: string;
};

export type DocxExportVolume = {
  title: string;
  chapters: DocxExportChapter[];
};

export type DocxExportCover = {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  content: Buffer;
};

export type DocxExportInput = {
  title: string;
  volumes: DocxExportVolume[];
  cover?: DocxExportCover | null;
};

/** A4 可用宽度约 6.5 英寸，按 96 DPI 取接近整页的封面显示尺寸。 */
const COVER_MAX_WIDTH_PX = 550;
const COVER_MAX_HEIGHT_PX = 720;

type EmbeddedCoverImage = {
  type: "jpg" | "png";
  data: Buffer;
  width: number;
  height: number;
};

function scaleCoverDimensions(width: number, height: number): { width: number; height: number } {
  const widthScale = COVER_MAX_WIDTH_PX / width;
  const heightScale = COVER_MAX_HEIGHT_PX / height;
  const scale = Math.min(1, widthScale, heightScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function prepareCoverImage(cover: DocxExportCover): Promise<EmbeddedCoverImage> {
  if (cover.mimeType === "image/webp" || cover.mimeType === "image/gif") {
    const png = await sharp(cover.content, { limitInputPixels: 16_777_216 }).png().toBuffer();
    const metadata = await sharp(png, { limitInputPixels: 16_777_216 }).metadata();
    const width = metadata.width ?? 1;
    const height = metadata.height ?? 1;
    const size = scaleCoverDimensions(width, height);
    return { type: "png", data: png, ...size };
  }

  const metadata = readRasterImageMetadata(cover.content);
  const size = scaleCoverDimensions(metadata.width, metadata.height);
  return {
    type: cover.mimeType === "image/jpeg" ? "jpg" : "png",
    data: cover.content,
    ...size
  };
}

function contentParagraphs(content: string): Paragraph[] {
  const normalized = content.replace(/\r\n?/gu, "\n");
  if (!normalized) return [new Paragraph({ children: [] })];
  return normalized.split("\n").map((line) => new Paragraph({
    children: line ? [new TextRun(line)] : []
  }));
}

async function buildCoverChildren(cover: DocxExportCover): Promise<Paragraph[]> {
  const image = await prepareCoverImage(cover);
  return [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          type: image.type,
          data: image.data,
          transformation: { width: image.width, height: image.height },
          altText: {
            title: "封面",
            description: "作品封面",
            name: "cover"
          }
        })
      ]
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];
}

export async function exportWorkDocx(input: DocxExportInput): Promise<Buffer> {
  const children: Paragraph[] = [];

  if (input.cover) {
    children.push(...await buildCoverChildren(input.cover));
  }

  children.push(new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun(input.title)]
  }));

  for (const volume of input.volumes) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun(volume.title)]
    }));
    for (const chapter of volume.chapters) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun(chapter.title)]
      }));
      children.push(...contentParagraphs(String(chapter.content ?? "")));
    }
  }

  const document = new Document({
    sections: [{ children }]
  });
  return Packer.toBuffer(document);
}
