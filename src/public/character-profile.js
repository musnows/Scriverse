function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeCharacterDetails(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    label: text(item?.label),
    value: text(item?.value)
  })).filter((item) => item.label && item.value);
}

export function normalizeCharacterSections(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    title: text(item?.title),
    content: text(item?.content)
  })).filter((item) => item.title && item.content);
}

export function buildCharacterDetails(labels, values) {
  const size = Math.max(labels.length, values.length);
  return normalizeCharacterDetails(Array.from({ length: size }, (_, index) => ({
    label: labels[index],
    value: values[index]
  })));
}

export function buildCharacterSections(titles, contents) {
  const size = Math.max(titles.length, contents.length);
  return normalizeCharacterSections(Array.from({ length: size }, (_, index) => ({
    title: titles[index],
    content: contents[index]
  })));
}
