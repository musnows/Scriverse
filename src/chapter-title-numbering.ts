export type ChapterNumberStyle = "arabic" | "chinese";

const chapterNumberTemplateToken = "{n}";
const existingChapterNumberPattern = /^(?:第\s*[〇零一二三四五六七八九十百千万两0-9０-９]+\s*章(?:\s*[上中下])?|chap(?:ter)?\.?\s*[0-9０-９]+|[0-9０-９]+\s*[.．、])\s*(?:[-—–:：.．、]\s*)?/iu;
const chineseDigits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"] as const;
const chineseGroupUnits = ["", "十", "百", "千"] as const;

function formatChineseGroup(value: number): string {
  const digits = String(value).padStart(4, "0");
  let result = "";
  let needsZero = false;
  for (const [index, character] of [...digits].entries()) {
    const digit = Number(character);
    const position = digits.length - index - 1;
    if (digit === 0) {
      if (result && [...digits.slice(index + 1)].some((remaining) => remaining !== "0")) needsZero = true;
      continue;
    }
    if (needsZero) result += chineseDigits[0];
    result += `${chineseDigits[digit] ?? ""}${chineseGroupUnits[position] ?? ""}`;
    needsZero = false;
  }
  return result;
}

export function isChapterNumberTemplate(value: string): boolean {
  const template = value.trim();
  if (!template || template.length > 50 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return template.split(chapterNumberTemplateToken).length === 2;
}

export function formatChapterNumber(value: number, style: ChapterNumberStyle): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999) {
    throw new RangeError("Chapter number must be an integer between 1 and 999999");
  }
  if (style === "arabic") return String(value);

  const highGroup = Math.floor(value / 10_000);
  const lowGroup = value % 10_000;
  let result = highGroup ? `${formatChineseGroup(highGroup)}万` : "";
  if (lowGroup) {
    if (highGroup && lowGroup < 1_000) result += chineseDigits[0];
    result += formatChineseGroup(lowGroup);
  }
  return result.replace(/^一十/u, "十");
}

export function chapterTitleWithoutNumber(title: string): string {
  return title.trim().replace(existingChapterNumberPattern, "").trim();
}

export function renumberChapterTitle(
  title: string,
  sequence: number,
  template: string,
  style: ChapterNumberStyle
): string {
  if (!isChapterNumberTemplate(template)) throw new Error("Invalid chapter number template");
  const numberPrefix = template.trim().replace(chapterNumberTemplateToken, formatChapterNumber(sequence, style));
  const suffix = chapterTitleWithoutNumber(title);
  return suffix ? `${numberPrefix} ${suffix}` : numberPrefix;
}

export const chapterTitleFormatIds = ["dot", "chapter-arabic", "chapter-chinese", "enumeration", "english"] as const;
export type ChapterTitleFormatId = typeof chapterTitleFormatIds[number];
export const chapterTitlePreferences = ["off", "auto", ...chapterTitleFormatIds] as const;
export type ChapterTitlePreference = typeof chapterTitlePreferences[number];

export const chapterTitleFormats: Record<ChapterTitleFormatId, {
  id: ChapterTitleFormatId;
  label: string;
  template: string;
  style: ChapterNumberStyle;
}> = {
  dot: { id: "dot", label: "N. 标题", template: "{n}.", style: "arabic" },
  "chapter-arabic": { id: "chapter-arabic", label: "第N章 标题", template: "第{n}章", style: "arabic" },
  "chapter-chinese": { id: "chapter-chinese", label: "第N章（中文数字）", template: "第{n}章", style: "chinese" },
  enumeration: { id: "enumeration", label: "N、标题", template: "{n}、", style: "arabic" },
  english: { id: "english", label: "Chapter N:", template: "Chapter {n}:", style: "arabic" }
};

const chineseDigitValues: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

export type ParsedChapterTitle = {
  formatId: ChapterTitleFormatId;
  number: number;
  suffix: string;
};

export type ChapterTitleUpdate = {
  id: string;
  title: string;
  sequence: number;
};

export function isChapterTitleFormatId(value: string): value is ChapterTitleFormatId {
  return Object.prototype.hasOwnProperty.call(chapterTitleFormats, value);
}

export function isChapterTitlePreference(value: string): value is ChapterTitlePreference {
  return (chapterTitlePreferences as readonly string[]).includes(value);
}

function parseArabicNumber(value: string): number | null {
  const normalized = value.replace(/[０-９]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
  if (!/^[0-9]+$/u.test(normalized)) return null;
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 1 || number > 999_999) return null;
  return number;
}

function parseChineseGroup(text: string): number | null {
  if (!text) return 0;
  let total = 0;
  let current: number | null = null;
  for (const character of text) {
    if (character === "零" || character === "〇") {
      if (current !== null) return null;
      current = 0;
      continue;
    }
    const digit = chineseDigitValues[character];
    if (digit !== undefined) {
      if (current !== null && current !== 0) return null;
      current = digit;
      continue;
    }
    const unit = character === "十" ? 10 : character === "百" ? 100 : character === "千" ? 1000 : 0;
    if (!unit) return null;
    total += (current === null || current === 0 ? 1 : current) * unit;
    current = null;
  }
  const value = total + (current ?? 0);
  return value >= 0 && value <= 9999 ? value : null;
}

function parseChineseNumber(value: string): number | null {
  if (!value || !/^[〇零一二三四五六七八九十百千万两]+$/u.test(value)) return null;
  const parts = value.split("万");
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const group = parseChineseGroup(parts[0] ?? "");
    return group && group > 0 ? group : null;
  }
  const high = parseChineseGroup(parts[0] ?? "");
  const low = parts[1] ? parseChineseGroup(parts[1]) : 0;
  if (high === null || low === null || high <= 0) return null;
  const number = high * 10_000 + low;
  return number >= 1 && number <= 999_999 ? number : null;
}

function parsedTitle(formatId: ChapterTitleFormatId, number: number, suffix: string): ParsedChapterTitle | null {
  if (number < 1 || number > 999_999) return null;
  return { formatId, number, suffix: suffix.trim() };
}

export function parseChapterTitleNumber(title: string): ParsedChapterTitle | null {
  const source = title.trim();
  const chapter = /^(第\s*)([0-9０-９]+|[〇零一二三四五六七八九十百千万两]+)(\s*章(?:\s*[上中下])?(?:\s*[-—–:：.．、])?\s*)(.*)$/u.exec(source);
  if (chapter) {
    const token = chapter[2] ?? "";
    const arabic = parseArabicNumber(token);
    const number = arabic ?? parseChineseNumber(token);
    if (number === null) return null;
    return parsedTitle(arabic === null ? "chapter-chinese" : "chapter-arabic", number, chapter[4] ?? "");
  }
  const english = /^(chap(?:ter)?\.?\s*)([0-9０-９]+)(\s*(?:[-—–:：.．]\s*)?)(.*)$/iu.exec(source);
  if (english) {
    const number = parseArabicNumber(english[2] ?? "");
    if (number === null) return null;
    return parsedTitle("english", number, english[4] ?? "");
  }
  const dotted = /^([0-9０-９]+)(\s*[.．]\s*)(.*)$/u.exec(source);
  if (dotted) {
    const number = parseArabicNumber(dotted[1] ?? "");
    if (number === null) return null;
    return parsedTitle("dot", number, dotted[3] ?? "");
  }
  const enumerated = /^([0-9０-９]+)(\s*、\s*)(.*)$/u.exec(source);
  if (enumerated) {
    const number = parseArabicNumber(enumerated[1] ?? "");
    if (number === null) return null;
    return parsedTitle("enumeration", number, enumerated[3] ?? "");
  }
  return null;
}

export function detectChapterTitleFormat(titles: readonly string[]): ChapterTitleFormatId | null {
  const counts = new Map<ChapterTitleFormatId, number>();
  for (const title of titles) {
    const parsed = parseChapterTitleNumber(title);
    if (!parsed) continue;
    counts.set(parsed.formatId, (counts.get(parsed.formatId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const winner = ranked[0];
  if (!winner) return null;
  const runnerUp = ranked[1]?.[1] ?? 0;
  return winner[1] > runnerUp ? winner[0] : null;
}

export function resolveChapterTitleFormat(preference: string, titles: readonly string[]): ChapterTitleFormatId | null {
  if (!isChapterTitlePreference(preference) || preference === "off") return null;
  if (preference === "auto") return detectChapterTitleFormat(titles);
  return preference;
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new RangeError("Chapter number must be an integer between 1 and 999999");
  }
}

export function planAutoNumberedTitles(
  chapters: readonly { id: string; title: string }[],
  targetId: string,
  rawTitle: string,
  formatId: ChapterTitleFormatId
): ChapterTitleUpdate[] {
  if (parseChapterTitleNumber(rawTitle)) return [];
  const targetIndex = chapters.findIndex((chapter) => chapter.id === targetId);
  if (targetIndex < 0) throw new Error("Missing chapter");
  let previous = 0;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const parsed = parseChapterTitleNumber(chapters[index]?.title ?? "");
    if (!parsed) continue;
    previous = parsed.number;
    break;
  }
  const assigned = previous + 1;
  assertSequence(assigned);
  const format = chapterTitleFormats[formatId];
  const updates: ChapterTitleUpdate[] = [{
    id: targetId,
    sequence: assigned,
    title: renumberChapterTitle(rawTitle, assigned, format.template, format.style)
  }];
  for (const chapter of chapters.slice(targetIndex + 1)) {
    const parsed = parseChapterTitleNumber(chapter.title);
    if (!parsed || parsed.number < assigned) continue;
    const sequence = parsed.number + 1;
    assertSequence(sequence);
    const kept = chapterTitleFormats[parsed.formatId];
    updates.push({
      id: chapter.id,
      sequence,
      title: renumberChapterTitle(chapter.title, sequence, kept.template, kept.style)
    });
  }
  return updates;
}

export function inferVolumeNumberStart(titles: readonly string[]): number {
  for (const [index, title] of titles.entries()) {
    const parsed = parseChapterTitleNumber(title);
    if (!parsed) continue;
    const start = parsed.number - index;
    return start >= 1 && start <= 999_999 ? start : 1;
  }
  return 1;
}

export function planVolumeTitleRenumber(
  chapters: readonly { id: string; title: string }[],
  formatId: ChapterTitleFormatId
): { updates: ChapterTitleUpdate[]; startAt: number } {
  const startAt = inferVolumeNumberStart(chapters.map((chapter) => chapter.title));
  const format = chapterTitleFormats[formatId];
  const updates = chapters.map((chapter, index) => {
    const sequence = startAt + index;
    assertSequence(sequence);
    return {
      id: chapter.id,
      sequence,
      title: renumberChapterTitle(chapter.title, sequence, format.template, format.style)
    };
  });
  return { updates, startAt };
}
