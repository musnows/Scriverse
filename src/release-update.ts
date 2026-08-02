const githubLatestReleaseUrl = "https://api.github.com/repos/musnows/Scriverse/releases/latest";
const githubReleasePathPrefix = "/musnows/Scriverse/releases/";
const minutesToMilliseconds = 60 * 1000;
const secondsToMilliseconds = 1000;
export const defaultReleaseCheckIntervalMs = 60 * minutesToMilliseconds;
export const minimumReleaseCheckIntervalMs = 10 * minutesToMilliseconds;
export const defaultReleaseCheckTimeoutMs = 90 * secondsToMilliseconds;
export const maximumReleaseCheckTimeoutMs = 300 * secondsToMilliseconds;
export const defaultReleaseCheckRetries = 1;
export const maximumReleaseCheckRetries = 5;

export type ReleaseUpdateResult = {
  checked: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  releaseUrl?: string;
  checkedAt?: string;
  nextCheckAt?: string;
};

export function resolveReleaseCheckIntervalMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return defaultReleaseCheckIntervalMs;
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return defaultReleaseCheckIntervalMs;
  return Math.max(minimumReleaseCheckIntervalMs, Math.round(minutes * minutesToMilliseconds));
}

export function resolveReleaseCheckTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return defaultReleaseCheckTimeoutMs;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return defaultReleaseCheckTimeoutMs;
  return Math.min(maximumReleaseCheckTimeoutMs, Math.round(seconds * secondsToMilliseconds));
}

export function resolveReleaseCheckRetries(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return defaultReleaseCheckRetries;
  const retries = Number(value);
  if (!Number.isFinite(retries) || retries < 0) return defaultReleaseCheckRetries;
  return Math.min(maximumReleaseCheckRetries, Math.floor(retries));
}

type CachedReleaseUpdateResult = {
  expiresAt: number;
  result: ReleaseUpdateResult;
};

function parseVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerRelease(currentVersion: string, candidateVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (!current || !candidate) return false;
  for (let index = 0; index < current.length; index += 1) {
    const currentPart = current[index]!;
    const candidatePart = candidate[index]!;
    if (candidatePart !== currentPart) return candidatePart > currentPart;
  }
  return false;
}

function validatedReleaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    if (!url.pathname.toLocaleLowerCase().startsWith(githubReleasePathPrefix.toLocaleLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export class ReleaseUpdateChecker {
  private readonly currentVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly now: () => number;
  private cached: CachedReleaseUpdateResult | null = null;
  private inFlight: Promise<ReleaseUpdateResult> | null = null;

  constructor(
    currentVersion: string,
    fetchImpl: typeof fetch = fetch,
    options: {
      intervalMs?: number;
      timeoutMs?: number;
      retries?: number;
      now?: () => number;
    } = {},
  ) {
    this.currentVersion = currentVersion;
    this.fetchImpl = fetchImpl;
    this.intervalMs = Math.max(minimumReleaseCheckIntervalMs, options.intervalMs ?? defaultReleaseCheckIntervalMs);
    this.timeoutMs = Math.max(secondsToMilliseconds, Math.min(maximumReleaseCheckTimeoutMs, options.timeoutMs ?? defaultReleaseCheckTimeoutMs));
    this.retries = Math.min(maximumReleaseCheckRetries, Math.max(0, Math.floor(options.retries ?? defaultReleaseCheckRetries)));
    this.now = options.now ?? Date.now;
  }

  check(): Promise<ReleaseUpdateResult> {
    if (this.cached && this.cached.expiresAt > this.now()) return Promise.resolve(this.cached.result);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchLatestRelease().then((result) => {
      const checkedAt = this.now();
      const scheduledResult = {
        ...result,
        checkedAt: new Date(checkedAt).toISOString(),
        nextCheckAt: new Date(checkedAt + this.intervalMs).toISOString()
      };
      this.cached = {
        expiresAt: checkedAt + this.intervalMs,
        result: scheduledResult
      };
      return scheduledResult;
    }).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchLatestRelease(): Promise<ReleaseUpdateResult> {
    const unavailable: ReleaseUpdateResult = {
      checked: false,
      updateAvailable: false,
      currentVersion: this.currentVersion
    };
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const response = await this.fetchImpl(githubLatestReleaseUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Scriverse-Update-Checker",
            "X-GitHub-Api-Version": "2022-11-28"
          },
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!response.ok) continue;
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
        const release = payload as Record<string, unknown>;
        if (typeof release.tag_name !== "string") continue;
        const releaseUrl = validatedReleaseUrl(release.html_url);
        if (!releaseUrl) continue;
        const latestVersion = release.tag_name.trim().replace(/^v/u, "");
        if (!parseVersion(latestVersion)) continue;
        const updateAvailable = isNewerRelease(this.currentVersion, latestVersion);
        return {
          checked: true,
          updateAvailable,
          currentVersion: this.currentVersion,
          latestVersion,
          ...(updateAvailable ? { releaseUrl } : {})
        };
      } catch {
        // 网络错误和超时由内部重试处理，耗尽次数后静默返回未探测状态
      }
    }
    return unavailable;
  }
}
