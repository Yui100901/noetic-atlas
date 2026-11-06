import type {
  ImportTaxonomyCatalog,
  ImportTaxonomyEntry,
  ImportTaxonomyMapping,
} from '../../../shared/models/import-taxonomy';

export type ImportTaxonomyKind = keyof ImportTaxonomyMapping;

export function importMappingEntry(
  mapping: ImportTaxonomyMapping,
  kind: ImportTaxonomyKind,
  sourceId: string,
) {
  return mapping[kind]?.find((entry) => entry.sourceId === sourceId);
}

export function changeImportMapping(
  mapping: ImportTaxonomyMapping,
  kind: ImportTaxonomyKind,
  sourceId: string,
  entry?: Omit<ImportTaxonomyEntry, 'sourceId'>,
): ImportTaxonomyMapping {
  const entries = (mapping[kind] || []).filter((value) => value.sourceId !== sourceId);
  if (entry) entries.push({ sourceId, ...entry });
  return { ...mapping, [kind]: entries };
}

/** A category mapping never guesses that differently named domains are the
 * same. Explicit domain choices take precedence; exact existing identity can
 * safely retain the default without forcing another click. */
export function mappedImportDomain(
  sourceId: string | null | undefined,
  source: ImportTaxonomyCatalog,
  local: ImportTaxonomyCatalog,
  mapping: ImportTaxonomyMapping,
): string | null | undefined {
  if (!sourceId) return null;
  const entry = importMappingEntry(mapping, 'domains', sourceId);
  if (entry) return entry.targetId || undefined;
  const original = source.domains.find((value) => value.id === sourceId);
  const existing = local.domains.find((value) => value.id === sourceId);
  return original &&
    existing &&
    original.name === existing.name &&
    original.description === existing.description &&
    original.sortOrder === existing.sortOrder
    ? existing.id
    : undefined;
}

export function importMappingTargets(
  kind: ImportTaxonomyKind,
  sourceId: string,
  source: ImportTaxonomyCatalog,
  local: ImportTaxonomyCatalog,
  mapping: ImportTaxonomyMapping,
) {
  if (kind === 'domains') return local.domains;
  const original = source[kind].find((value) => value.id === sourceId);
  if (!original) return [];
  const domain = mappedImportDomain(original.domainId, source, local, mapping);
  if (kind === 'categories')
    return domain ? local.categories.filter((value) => value.domainId === domain) : [];
  return local.tags.filter((value) => !value.domainId || (!!domain && value.domainId === domain));
}

export function importMappingIssue(
  source: ImportTaxonomyCatalog | null,
  local: ImportTaxonomyCatalog,
  mapping: ImportTaxonomyMapping,
): string {
  if (!source) return '';
  const kinds: ImportTaxonomyKind[] = ['domains', 'categories', 'tags'];
  for (const kind of kinds)
    for (const entry of mapping[kind] || []) {
      const original = source[kind].find((value) => value.id === entry.sourceId);
      if (!original) return '归属选择不属于当前数据包，请重新选择。';
      if (entry.name !== undefined && !entry.name.trim())
        return `请填写“${original.name}”的新名称。`;
      if (
        entry.targetId !== undefined &&
        !importMappingTargets(kind, entry.sourceId, source, local, mapping).some(
          (value) => value.id === entry.targetId,
        )
      )
        return `请为“${original.name}”选择有效的本地目标；分类和领域标签应先确定所属领域。`;
    }
  return '';
}
