type RelationshipFilterItem = {
  id?: string;
  fromCharacterId?: string | null;
  toCharacterId?: string | null;
};

export declare function filterRelationships<T extends RelationshipFilterItem>(
  relationships: T[],
  filters?: { fromCharacterIds?: string[]; toCharacterIds?: string[] }
): T[];

export declare function sortCharacterRelationships<T extends RelationshipFilterItem & { confidence?: number | string | null; createdAt?: string | null }>(
  relationships: T[],
  characterId: string | null | undefined
): T[];
