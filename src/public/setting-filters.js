function normalizedText(value) {
  return String(value ?? "").toLocaleLowerCase("zh-CN");
}

export function filterSettings(records, { keyword = "", category = "", lockState = "all" } = {}) {
  const normalizedKeyword = normalizedText(keyword).trim();
  const normalizedCategory = String(category ?? "").trim();
  const normalizedLockState = lockState === "locked" || lockState === "unlocked" ? lockState : "all";

  return records.filter((record) => {
    const matchesKeyword = !normalizedKeyword
      || normalizedText(record?.title).includes(normalizedKeyword)
      || normalizedText(record?.contentPreview).includes(normalizedKeyword);
    const matchesCategory = !normalizedCategory || String(record?.category ?? "") === normalizedCategory;
    const matchesLockState = normalizedLockState === "all"
      || (normalizedLockState === "locked" ? Boolean(record?.locked) : !record?.locked);
    return matchesKeyword && matchesCategory && matchesLockState;
  });
}
