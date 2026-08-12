export const FORESHADOW_REMINDER_SNOOZE_STORAGE_KEY = "scriverse.foreshadow-reminder-snoozes.v1";

function normalizedId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function normalizeForeshadowReminders(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const foreshadowId = normalizedId(item.foreshadowId);
    const occurrenceId = normalizedId(item.occurrenceId);
    const title = String(item.title ?? "").trim();
    const role = item.role === "payoff" ? "payoff" : item.role === "reminder" ? "reminder" : null;
    const versionNo = Number(item.versionNo);
    if (!foreshadowId || !occurrenceId || !title || !role || !Number.isInteger(versionNo) || versionNo < 1) return [];
    return [{
      foreshadowId,
      occurrenceId,
      title,
      description: String(item.description ?? ""),
      status: item.status === "planned" ? "planned" : "planted",
      importance: ["low", "medium", "high"].includes(item.importance) ? item.importance : "medium",
      role,
      note: String(item.note ?? ""),
      versionNo,
      updatedAt: String(item.updatedAt ?? "")
    }];
  });
}

export function foreshadowReminderSnoozeKey(workId, chapterId, reminder) {
  const parts = [
    normalizedId(workId),
    normalizedId(chapterId),
    normalizedId(reminder?.foreshadowId),
    normalizedId(reminder?.occurrenceId)
  ];
  const versionNo = Number(reminder?.versionNo);
  if (parts.some((part) => !part) || !Number.isInteger(versionNo) || versionNo < 1) return null;
  return [...parts, `v${versionNo}`].map((part) => encodeURIComponent(part)).join("|");
}

export function parseForeshadowReminderSnoozes(serialized) {
  try {
    const value = JSON.parse(String(serialized ?? "[]"));
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length <= 1000) : []);
  } catch {
    return new Set();
  }
}

export function serializeForeshadowReminderSnoozes(snoozes, limit = 500) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 500;
  const values = [...snoozes].filter((item) => typeof item === "string" && item.length <= 1000);
  return JSON.stringify(values.slice(-safeLimit));
}

export function visibleForeshadowReminders(reminders, workId, chapterId, snoozes) {
  return normalizeForeshadowReminders(reminders).filter((reminder) => {
    const key = foreshadowReminderSnoozeKey(workId, chapterId, reminder);
    return key && !snoozes.has(key);
  });
}

export function foreshadowReminderRequestTargetsState(request, current) {
  return Boolean(
    request
    && normalizedId(request.workId) === normalizedId(current?.workId)
    && normalizedId(request.chapterId) === normalizedId(current?.chapterId)
  );
}
