function validDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function localDayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatAiMessageTime(createdAt, previousCreatedAt = null) {
  const created = validDate(createdAt);
  if (!created) return "";
  const time = `${pad(created.getHours())}:${pad(created.getMinutes())}`;
  const previous = validDate(previousCreatedAt);
  return previous && localDayKey(previous) !== localDayKey(created)
    ? `${localDayKey(created)} ${time}`
    : time;
}
