export const BROWSER_AI_STORAGE_KEY = "scriverse-demo-browser-ai";

const defaultState = () => ({
  providers: [],
  models: [],
  platformSettings: { systemPrompt: "", imageToolModelId: null, updatedAt: null },
  workSettings: {},
  taskDefaults: {},
  conversations: {}
});

function normalizedState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    providers: Array.isArray(source.providers) ? source.providers : [],
    models: Array.isArray(source.models) ? source.models : [],
    platformSettings: source.platformSettings && typeof source.platformSettings === "object" ? { ...defaultState().platformSettings, ...source.platformSettings } : { ...defaultState().platformSettings },
    workSettings: source.workSettings && typeof source.workSettings === "object" ? source.workSettings : {},
    taskDefaults: source.taskDefaults && typeof source.taskDefaults === "object" ? source.taskDefaults : {},
    conversations: source.conversations && typeof source.conversations === "object" ? source.conversations : {}
  };
}

export function createBrowserAiStore(storage) {
  return {
    read() {
      const raw = storage.getItem(BROWSER_AI_STORAGE_KEY);
      if (!raw) return defaultState();
      try {
        return normalizedState(JSON.parse(raw));
      } catch {
        return defaultState();
      }
    },
    update(mutator) {
      const state = this.read();
      const result = mutator(state) ?? state;
      storage.setItem(BROWSER_AI_STORAGE_KEY, JSON.stringify(result));
      return result;
    }
  };
}

export function normalizeProviderBaseUrl(value) {
  const url = new URL(String(value ?? "").trim());
  if (!/^https?:$/u.test(url.protocol)) throw new Error("供应商地址必须使用 HTTP 或 HTTPS");
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|messages|models)\/?$/u, "").replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

export function providerApiUrl(baseUrl, resource) {
  return `${normalizeProviderBaseUrl(baseUrl)}/${String(resource).replace(/^\/+/, "")}`;
}

function versionedProviderApiUrl(baseUrl, resource) {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  return `${normalized}${/\/v1$/u.test(normalized) ? "" : "/v1"}/${String(resource).replace(/^\/+/, "")}`;
}

export function publicProvider(provider) {
  const key = String(provider.apiKey ?? "");
  return {
    ...provider,
    apiKey: key ? `${key.slice(0, 3)}••••${key.slice(-2)}（仅浏览器）` : "未配置"
  };
}

function chapterList(work) {
  if (Array.isArray(work?.chapters)) return work.chapters;
  return (work?.volumes ?? []).flatMap((volume) => volume.chapters ?? []);
}

function scopeContext(work, scope) {
  const chapters = chapterList(work);
  if (scope?.type === "selection") return `当前选中文本：\n${String(scope.selection ?? "").slice(0, 24000)}`;
  if (scope?.type === "chapter" || scope?.chapterId) {
    const chapter = chapters.find((item) => item.id === scope.chapterId);
    if (chapter) return `当前章节：${chapter.title}\n\n${String(chapter.content ?? "").slice(0, 24000)}`;
  }
  if (scope?.type === "volume") {
    const volume = (work?.volumes ?? []).find((item) => item.id === scope.volumeId);
    if (volume) return `当前分卷：${volume.title}\n${(volume.chapters ?? []).map((chapter) => `${chapter.title}：${String(chapter.content ?? "").slice(0, 500)}`).join("\n")}`;
  }
  if (scope?.type === "book") {
    return `全书章节概览：\n${chapters.map((chapter) => `${chapter.title}：${String(chapter.content ?? "").slice(0, 280)}`).join("\n").slice(0, 24000)}`;
  }
  if (scope?.type === "settings-catalog" || scope?.type === "settings") {
    return `世界观设定：\n${(work?.settings ?? []).map((setting) => `${setting.title}：${String(setting.content ?? "").slice(0, 900)}`).join("\n").slice(0, 24000)}`;
  }
  if (scope?.type === "characters") {
    return `人物档案：\n${(work?.characters ?? []).map((character) => `${character.name}：${String(character.profile?.summary ?? "").slice(0, 700)}`).join("\n").slice(0, 24000)}`;
  }
  if (scope?.type === "races") {
    return `种族档案：\n${(work?.races ?? []).map((race) => `${race.name}：${String(race.description ?? "").slice(0, 700)}`).join("\n").slice(0, 16000)}`;
  }
  if (scope?.type === "organizations") {
    return `组织档案：\n${(work?.organizations ?? []).map((organization) => `${organization.name}：${String(organization.description ?? "").slice(0, 700)}`).join("\n").slice(0, 16000)}`;
  }
  if (scope?.type === "timeline") {
    return `时间线：\n${(work?.timeline ?? []).map((event) => `${event.timeLabel ?? "时间待定"} · ${event.name}：${String(event.description ?? "").slice(0, 500)}`).join("\n").slice(0, 16000)}`;
  }
  if (scope?.type === "relationships") {
    return `人物关系：\n${(work?.relationships ?? []).map((relationship) => `${relationship.fromCharacterId ?? "未知"} - ${relationship.subtype || relationship.category} - ${relationship.toCharacterId ?? "未知"}`).join("\n").slice(0, 12000)}`;
  }
  if (scope?.type === "foreshadows") {
    return `伏笔：\n${(work?.foreshadows ?? []).map((item) => `${item.title}：${String(item.description ?? "").slice(0, 600)}（${item.status}）`).join("\n").slice(0, 12000)}`;
  }
  if (scope?.type === "entities") {
    const selectedCharacters = new Set(scope.characterIds ?? []);
    const selectedSettings = new Set(scope.settingIds ?? []);
    const selectedRaces = new Set(scope.raceIds ?? []);
    const selectedOrganizations = new Set(scope.organizationIds ?? []);
    const sections = [
      ...(work?.characters ?? []).filter((item) => selectedCharacters.has(item.id)).map((item) => `角色 ${item.name}：${item.profile?.summary ?? ""}`),
      ...(work?.settings ?? []).filter((item) => selectedSettings.has(item.id)).map((item) => `设定 ${item.title}：${item.content ?? ""}`),
      ...(work?.races ?? []).filter((item) => selectedRaces.has(item.id)).map((item) => `种族 ${item.name}：${item.description ?? ""}`),
      ...(work?.organizations ?? []).filter((item) => selectedOrganizations.has(item.id)).map((item) => `组织 ${item.name}：${item.description ?? ""}`)
    ];
    return `指定资料：\n${sections.join("\n").slice(0, 24000) || "暂无指定资料。"}`;
  }
  return "本次请求未附加正文上下文。";
}

export function buildBrowserAiMessages({ work, scope, instruction, platformPrompt = "", workPrompt = "", conversationMessages = [], citations = [], roleplayCharacter = null }) {
  const systemParts = [
    "你是叙界演示站中的小说创作助手。请使用简体中文回答，尊重作者决定，不要声称已经修改正文。",
    platformPrompt,
    workPrompt,
    `作品：${work?.title ?? "未命名作品"}\n简介：${work?.description ?? ""}`,
    roleplayCharacter ? `当前角色卡：${roleplayCharacter.name}\n${roleplayCharacter.code ? `角色代号：${roleplayCharacter.code}` : ""}` : "",
    scopeContext(work, scope)
  ].filter((part) => String(part).trim());
  if (citations.length) systemParts.push(`作者引用：\n${citations.map((item) => `${item.chapterTitle ?? "章节"}：${item.text ?? ""}`).join("\n").slice(0, 12000)}`);
  const history = conversationMessages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .slice(-12)
    .map((message) => ({ role: message.role, content: String(message.content ?? "") }));
  if (history.at(-1)?.role !== "user" || history.at(-1)?.content !== instruction) history.push({ role: "user", content: instruction });
  return [{ role: "system", content: systemParts.join("\n\n") }, ...history];
}

function completionText(payload) {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  const contentText = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((item) => typeof item === "string" ? item : item?.text ?? "").join("")
      : "";
  const messageText = [message?.reasoning_content, contentText].filter((part) => typeof part === "string" && part.trim()).join("\n");
  if (messageText) return messageText;
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (Array.isArray(payload?.content)) {
    const anthropicText = payload.content.map((item) => typeof item === "string" ? item : item?.text ?? "").join("");
    if (anthropicText.trim()) return anthropicText;
  }
  throw new Error("模型响应中没有可用文本");
}

export async function requestBrowserAi({ fetchImpl, provider, model, messages }) {
  const isAnthropic = provider.protocol === "anthropic-messages";
  if (provider.protocol === "google-vertex") throw new Error("Google Vertex 需要服务端 OAuth，演示站浏览器直连模式暂不支持该协议");
  const system = messages.find((message) => message.role === "system")?.content ?? "";
  const requestMessages = messages.filter((message) => message.role !== "system");
  const response = await fetchImpl(isAnthropic
    ? versionedProviderApiUrl(provider.baseUrl, "messages")
    : providerApiUrl(provider.baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
      ...(isAnthropic ? { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" } : {})
    },
    body: JSON.stringify(isAnthropic
      ? {
        model: model.modelId,
        system,
        messages: requestMessages,
        temperature: Number(model.preset?.temperature ?? 0.7),
        max_tokens: Number(model.preset?.max_tokens ?? provider.maxTokens ?? 32000)
      }
      : {
        model: model.modelId,
        messages,
        stream: false,
        temperature: Number(model.preset?.temperature ?? 0.7),
        max_tokens: Number(model.preset?.max_tokens ?? provider.maxTokens ?? 32000)
      })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? `供应商请求失败：${response.status}`);
  return {
    content: completionText(payload),
    outputTokens: Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? 0)
  };
}

export async function testBrowserAiProvider({ fetchImpl, provider }) {
  if (provider.protocol === "google-vertex") throw new Error("Google Vertex 需要服务端 OAuth，演示站浏览器直连模式暂不支持该协议");
  if (provider.protocol === "anthropic-messages") {
    const modelId = "claude-3-5-sonnet-latest";
    await testBrowserAiModel({ fetchImpl, provider, model: { modelId, preset: { temperature: 0, max_tokens: 8 } } });
    return { ok: true, availableModels: [modelId] };
  }
  const response = await fetchImpl(provider.protocol === "anthropic-messages"
    ? versionedProviderApiUrl(provider.baseUrl, "models")
    : providerApiUrl(provider.baseUrl, "models"), {
    headers: { Accept: "application/json", Authorization: `Bearer ${provider.apiKey}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `连接测试失败：${response.status}`);
  }
  const availableModels = Array.isArray(payload?.data)
    ? payload.data.map((item) => String(item?.id ?? "").trim()).filter(Boolean)
    : [];
  if (!availableModels.length) throw new Error("AI 供应商没有返回可用模型");
  await testBrowserAiModel({
    fetchImpl,
    provider,
    model: { modelId: availableModels[0], preset: { temperature: 0, max_tokens: 8 } }
  });
  return { ok: true, availableModels };
}

export async function testBrowserAiModel({ fetchImpl, provider, model }) {
  await requestBrowserAi({
    fetchImpl,
    provider,
    model,
    messages: [{ role: "user", content: "仅回复 OK" }]
  });
  return { ok: true };
}
