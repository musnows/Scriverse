import type { ParsedChapter, ParsedNovel, ParsedVolume } from "./domain.js";
import { countWords } from "./utils.js";

const volumePattern = /^\s*(?:第[零一二三四五六七八九十百千万两\d]+卷|卷[零一二三四五六七八九十百千万两\d]+)(?:\s+|[:：]\s*|$)[^\n]*\s*$/u;
const chapterPattern = /^\s*(?:第[零一二三四五六七八九十百千万两\d]+章(?:[上中下])?|序章|楔子|终章|后记|作者的话)(?:\s+|[:：]\s*|$)[^\n]*\s*$/u;
const specialPattern = /^\s*(前传|番外|附录)(?:\s+|[:：]\s*|$)([^\n]*)\s*$/u;

function titleOf(line: string): string {
  return line.trim().replace(/\s+/gu, " ");
}

function kindOf(title: string): ParsedVolume["kind"] {
  if (/^前传/u.test(title)) return "prequel";
  if (/^番外/u.test(title)) return "extra";
  if (/^附录/u.test(title)) return "appendix";
  return "main";
}

function chapterTypeOf(title: string): ParsedChapter["chapterType"] {
  return /^(?:后记|作者的话)/u.test(title) ? "作者的话" : "正文";
}

export function parseNovelText(raw: string): ParsedNovel {
  const text = raw.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  const originalLines = text ? text.split("\n") : [];
  const headingKey = (line: string): string | null => {
    const match = line.trim().match(/^(第[零一二三四五六七八九十百千万两\d]+[卷章]|卷[零一二三四五六七八九十百千万两\d]+|序章|楔子|终章|前传|番外|后记|附录)/u);
    return match?.[1] ?? null;
  };
  const ignoredDirectoryLines = new Set<number>();
  const directoryIndexes = originalLines
    .map((line, index) => /^\s*目\s*录\s*$/u.test(line) ? index : -1)
    .filter((index) => index >= 0);
  for (const directoryIndex of directoryIndexes) {
    const pageHeadingKeys = new Set<string>();
    let pageEntryCount = 0;
    let bodyBoundary = -1;
    const scanLimit = Math.min(originalLines.length, directoryIndex + 5000);
    for (let index = directoryIndex + 1; index < scanLimit; index += 1) {
      const line = originalLines[index] ?? "";
      const key = headingKey(line);
      const hasPageNumber = /(?:\t\s*\d+| {2,}\d+)\s*$/u.test(line);
      if (hasPageNumber) {
        pageEntryCount += 1;
        if (key) pageHeadingKeys.add(key);
        continue;
      }
      if (key && pageEntryCount >= 3 && pageHeadingKeys.size >= 2 && pageHeadingKeys.has(key)) {
        bodyBoundary = index;
        break;
      }
    }
    if (bodyBoundary > directoryIndex) {
      for (let index = directoryIndex; index < bodyBoundary; index += 1) ignoredDirectoryLines.add(index);
      continue;
    }

    let simpleEnd = directoryIndex + 1;
    const simpleKeys: string[] = [];
    let started = false;
    while (simpleEnd < originalLines.length) {
      const line = originalLines[simpleEnd] ?? "";
      if (!line.trim()) {
        if (started) break;
        simpleEnd += 1;
        continue;
      }
      const key = headingKey(line);
      if (!key) break;
      started = true;
      simpleKeys.push(key);
      simpleEnd += 1;
    }
    const laterKeys = new Set(originalLines.slice(simpleEnd).map(headingKey).filter((value): value is string => Boolean(value)));
    if (simpleKeys.length >= 2 && simpleKeys.some((key) => laterKeys.has(key))) {
      for (let index = directoryIndex; index < simpleEnd; index += 1) ignoredDirectoryLines.add(index);
    }
  }
  const lines = originalLines.filter((_line, index) => !ignoredDirectoryLines.has(index));
  const hasExplicitVolume = lines.some((line) => volumePattern.test(line) || specialPattern.test(line));
  const warnings: string[] = [];
  const volumes: ParsedVolume[] = [];
  let currentVolume: ParsedVolume | undefined;
  let currentChapter: ParsedChapter | undefined;
  let preamble: string[] = [];

  const ensureVolume = (): ParsedVolume => {
    if (!currentVolume) {
      currentVolume = {
        title: hasExplicitVolume ? "未归属内容" : "正文",
        kind: "main",
        source: "default",
        order: volumes.length,
        chapters: []
      };
      volumes.push(currentVolume);
    }
    return currentVolume;
  };

  const flushChapter = (): void => {
    if (!currentChapter) return;
    currentChapter.content = currentChapter.content.trim();
    ensureVolume().chapters.push(currentChapter);
    currentChapter = undefined;
  };

  const flushPreamble = (): void => {
    const content = preamble.join("\n").trim();
    preamble = [];
    if (!content) return;
    const volume = ensureVolume();
    volume.chapters.push({
      title: volume.chapters.length === 0 ? "卷首" : "未命名章节",
      content,
      order: volume.chapters.length,
      chapterType: "正文"
    });
  };

  for (const line of lines) {
    if (volumePattern.test(line) || specialPattern.test(line)) {
      flushChapter();
      flushPreamble();
      const title = titleOf(line);
      currentVolume = {
        title,
        kind: kindOf(title),
        source: "explicit",
        order: volumes.length,
        chapters: []
      };
      volumes.push(currentVolume);
      continue;
    }

    if (chapterPattern.test(line)) {
      flushChapter();
      flushPreamble();
      const volume = ensureVolume();
      currentChapter = {
        title: titleOf(line),
        content: "",
        order: volume.chapters.length,
        chapterType: chapterTypeOf(titleOf(line))
      };
      continue;
    }

    if (currentChapter) {
      currentChapter.content += `${currentChapter.content ? "\n" : ""}${line}`;
    } else {
      preamble.push(line);
    }
  }

  flushChapter();
  flushPreamble();

  if (volumes.length === 0) {
    volumes.push({
      title: "正文",
      kind: "main",
      source: "default",
      order: 0,
      chapters: []
    });
  }

  for (const volume of volumes) {
    volume.chapters.forEach((chapter, index) => {
      chapter.order = index;
    });
  }

  if (!hasExplicitVolume) warnings.push("未检测到明确卷标题，内容保留在默认卷中");
  if (ignoredDirectoryLines.size > 0) warnings.push(`已忽略目录中的 ${ignoredDirectoryLines.size} 行导航内容`);
  if (volumes.some((volume) => volume.title === "未归属内容")) warnings.push("卷标题前存在正文内容，已标记为未归属内容");
  if (volumes.some((volume) => volume.chapters.length === 0)) warnings.push("检测到空卷");

  return {
    volumes,
    warnings,
    wordCount: countWords(text),
    paragraphCount: originalLines.filter((line) => line.trim()).length
  };
}

export function applyImportFileHints(parsed: ParsedNovel, fileName: string): ParsedNovel {
  if (!/前传/u.test(fileName) || !parsed.volumes.some((volume) => volume.source === "explicit")) return parsed;
  const leadingDefaultVolume = parsed.volumes.find((volume) => volume.source === "default");
  if (!leadingDefaultVolume) return parsed;
  leadingDefaultVolume.title = "前传";
  leadingDefaultVolume.kind = "prequel";
  parsed.warnings = parsed.warnings.filter((warning) => warning !== "卷标题前存在正文内容，已标记为未归属内容");
  parsed.warnings.push("根据文件名将首个未分卷内容识别为前传");
  return parsed;
}
