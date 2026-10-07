export function shouldSuppressChapterCreateEnter(event) {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229;
}

export function bindChapterCreateEnterGuard(form) {
  let suppressEnterSubmit = false;
  form.onkeydown = (event) => {
    if (!shouldSuppressChapterCreateEnter(event)) return;
    event.preventDefault();
    suppressEnterSubmit = true;
    queueMicrotask(() => {
      suppressEnterSubmit = false;
    });
  };
  return {
    consumeSuppressedEnter(event) {
      if (!suppressEnterSubmit) return false;
      suppressEnterSubmit = false;
      event.preventDefault();
      return true;
    }
  };
}
