export type ReportedVersion = {
  major: number;
  minor: number;
  patch: number;
  /** 第四段是 Desktop 修复修订。三段版本没有该段；四段里的 0 是真实修订，不是缺失。 */
  desktopRevision: number | null;
};

export type ServerVersionRelation = "older" | "equal" | "newer";

const reportedVersionPattern = /^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/u;

/** 接受三段 Server 版本和四段 Desktop 版本。无法解析时返回 null，不回落成 0.0.1。 */
export function parseReportedVersion(value: string): ReportedVersion | null {
  const match = reportedVersionPattern.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    desktopRevision: match[4] === undefined ? null : Number(match[4])
  };
}

/**
 * 只比较前三段。第四段不参与 Server 兼容判断，因此 `1.1.7.1` 与 `1.1.7` 对齐，
 * `1.1.8.0` 与 `1.1.8` 对齐。任一侧无法解析时返回 null，调用方不得把 null 当成更旧。
 */
export function compareServerAlignment(left: string, right: string): ServerVersionRelation | null {
  const parsedLeft = parseReportedVersion(left);
  const parsedRight = parseReportedVersion(right);
  if (!parsedLeft || !parsedRight) return null;
  const pairs: Array<[number, number]> = [
    [parsedLeft.major, parsedRight.major],
    [parsedLeft.minor, parsedRight.minor],
    [parsedLeft.patch, parsedRight.patch]
  ];
  for (const [leftPart, rightPart] of pairs) {
    if (leftPart < rightPart) return "older";
    if (leftPart > rightPart) return "newer";
  }
  return "equal";
}
