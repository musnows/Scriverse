export function shouldSendAiPrompt(event) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
