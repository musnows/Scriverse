export type CharacterDetail = { label: string; value: string };
export type CharacterSection = { title: string; content: string };

export function normalizeCharacterDetails(value: unknown): CharacterDetail[];
export function normalizeCharacterSections(value: unknown): CharacterSection[];
export function buildCharacterDetails(labels: unknown[], values: unknown[]): CharacterDetail[];
export function buildCharacterSections(titles: unknown[], contents: unknown[]): CharacterSection[];
export function characterStateEntries(value: unknown): CharacterDetail[];
export function buildCharacterState(labels: unknown[], values: unknown[], previous?: Record<string, unknown>): Record<string, unknown>;
