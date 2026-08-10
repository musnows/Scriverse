const activeTaskStatuses = new Set(["pending", "running"]);
const terminalTaskStatuses = new Set(["review", "completed", "partial", "failed", "expired", "cancelled"]);

export function backgroundTaskActivityCount(taskPage, relationshipIndex) {
  const pendingCount = Number(taskPage?.stats?.pendingCount ?? 0);
  const runningCount = Number(taskPage?.stats?.runningCount ?? 0);
  const indexActive = ["queued", "building"].includes(String(relationshipIndex?.status))
    || Number(relationshipIndex?.queuedSourceCount ?? 0) > 0;
  return Math.max(0, pendingCount) + Math.max(0, runningCount) + (indexActive ? 1 : 0);
}

export function collectBackgroundTaskTransitions(previousSnapshots, tasks, initialized) {
  const snapshots = new Map(previousSnapshots instanceof Map ? previousSnapshots : []);
  const transitions = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const taskId = String(task?.id ?? "");
    if (!taskId) continue;
    const status = String(task?.status ?? "");
    const previousStatus = snapshots.get(taskId);
    if (initialized && activeTaskStatuses.has(previousStatus) && terminalTaskStatuses.has(status)) {
      transitions.push({ task, previousStatus, status });
    }
    snapshots.set(taskId, status);
  }
  return { snapshots, transitions };
}

export function backgroundTaskPollDelay(activityCount, dialogOpen = false) {
  return dialogOpen || Number(activityCount) > 0 ? 5_000 : 15_000;
}
