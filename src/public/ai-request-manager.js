function normalizedId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function createAiRequestAbortError(message = "AI 请求已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "AI_REQUEST_CANCELLED";
  return error;
}

export function isAiRequestCancellation(error, request = null) {
  if (request?.signal?.aborted) return true;
  return error?.name === "AbortError" || error?.code === "AI_REQUEST_CANCELLED";
}

export function aiRequestTargetsState(request, current) {
  if (!request || normalizedId(current?.workId) !== request.workId) return false;
  return request.conversationId === null
    || normalizedId(current?.conversationId) === request.conversationId;
}

export function createAiRequestManager() {
  let generation = 0;
  let active = null;

  const snapshot = (input, controller, requestGeneration) => Object.freeze({
    generation: requestGeneration,
    workId: normalizedId(input.workId),
    conversationId: normalizedId(input.conversationId),
    userMessageId: normalizedId(input.userMessageId),
    signal: controller.signal
  });

  const isCurrent = (request) => Boolean(
    request
    && active
    && !active.controller.signal.aborted
    && active.snapshot.generation === request.generation
    && active.controller.signal === request.signal
  );

  const cancel = (reason = "AI 请求已取消") => {
    if (!active) return false;
    const current = active;
    active = null;
    current.controller.abort(createAiRequestAbortError(reason));
    return true;
  };

  const begin = (input) => {
    cancel("新的 AI 请求已开始");
    const controller = new AbortController();
    generation += 1;
    const request = snapshot(input, controller, generation);
    if (!request.workId) throw new Error("AI 请求必须绑定作品");
    active = { controller, snapshot: request };
    return request;
  };

  const bind = (request, patch) => {
    if (!isCurrent(request)) throw createAiRequestAbortError("AI 请求已失效");
    const conversationId = Object.hasOwn(patch, "conversationId")
      ? normalizedId(patch.conversationId)
      : request.conversationId;
    const userMessageId = Object.hasOwn(patch, "userMessageId")
      ? normalizedId(patch.userMessageId)
      : request.userMessageId;
    if (request.conversationId && conversationId !== request.conversationId) {
      throw new Error("AI 请求不能改绑到其他对话");
    }
    if (request.userMessageId && userMessageId !== request.userMessageId) {
      throw new Error("AI 请求不能改绑到其他用户消息");
    }
    const next = snapshot({
      workId: request.workId,
      conversationId,
      userMessageId
    }, active.controller, request.generation);
    active.snapshot = next;
    return next;
  };

  const finish = (request) => {
    if (!isCurrent(request)) return false;
    active = null;
    return true;
  };

  return {
    begin,
    bind,
    cancel,
    finish,
    hasActive: () => active !== null,
    isCurrent
  };
}
