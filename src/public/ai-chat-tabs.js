function normalizedId(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function createAiChatTabManager(createId = null) {
  const tabs = [];
  let activeId = null;
  let sequence = 0;

  const nextId = () => {
    sequence += 1;
    return createId?.() ?? `ai-tab-${sequence}`;
  };

  const get = (tabId) => tabs.find((tab) => tab.id === normalizedId(tabId)) ?? null;

  const open = (input = {}) => {
    const conversationId = normalizedId(input.conversationId);
    const existing = conversationId
      ? tabs.find((tab) => normalizedId(tab.conversationId) === conversationId)
      : null;
    if (existing) {
      activeId = existing.id;
      return existing;
    }
    const tab = { ...input, id: normalizedId(input.id) ?? nextId(), conversationId };
    tabs.push(tab);
    activeId = tab.id;
    return tab;
  };

  const activate = (tabId) => {
    const tab = get(tabId);
    if (!tab) return null;
    activeId = tab.id;
    return tab;
  };

  const close = (tabId) => {
    const index = tabs.findIndex((tab) => tab.id === normalizedId(tabId));
    if (index < 0) return { closed: null, active: get(activeId) };
    const [closed] = tabs.splice(index, 1);
    if (closed.id === activeId) {
      activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    }
    return { closed, active: get(activeId) };
  };

  const reset = (input = null) => {
    tabs.splice(0, tabs.length);
    activeId = null;
    return input ? open(input) : null;
  };

  return {
    activate,
    active: () => get(activeId),
    close,
    findByConversation: (conversationId) => tabs.find((tab) => normalizedId(tab.conversationId) === normalizedId(conversationId)) ?? null,
    get,
    list: () => [...tabs],
    open,
    reset
  };
}
