import type { AssetRecord } from '../../../shared/assets/assets.js';
import { collectAssetReferences } from '../../../shared/assets/asset-references.js';
import type { Category, Domain, Question, Tag } from '../../../shared/models/types.js';
import { questionRevisionContent } from '../../../shared/questions/question-revisions.js';
import type { Store } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { validateAssetRecord } from '../assets/schema.js';

/** Export only authoring fields, even if the caller supplied an enriched detail
 * response. Citations remain readable without exposing local document IDs. */
export function cleanContentQuestion(question: Question): Question {
  const content = questionRevisionContent(question);
  return {
    ...content,
    id: question.id,
    status: question.status,
    ...(question.createdAt ? { createdAt: question.createdAt } : {}),
    ...(question.updatedAt ? { updatedAt: question.updatedAt } : {}),
    sourceDocument: null,
    sourceAnchor: null,
    ...(content.documentLinks
      ? {
          documentLinks: content.documentLinks.map((link) => ({
            ...link,
            documentId: null,
            versionId: null,
          })),
        }
      : {}),
  };
}

/** Keep an independently importable file's internal links; detach absent
 * targets instead of accidentally linking to an unrelated local question. */
export function detachQuestionLinks<T>(
  value: T,
  chosen: ReadonlySet<string>,
  mode: 'missing' | 'search' = 'missing',
): T {
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string')
      return item
        .replace(
          /\[([^\]]+)\]\(#\/questions\/([^/\s)"?#]+)(?:\?[^)\s"]*)?\)/g,
          (whole, label: string, target: string) =>
            mode === 'search'
              ? `[${label}](#/questions?search=${encodeURIComponent(decode(target))})`
              : chosen.has(decode(target))
                ? whole
                : `${label}（关联题未包含在本文件）`,
        )
        .replace(
          /(^|[\s("'<>])#\/questions\/([^/\s?#"'()<>\]]+)(?:\?[^)\s"'<>\]]*)?/g,
          (whole, prefix: string, target: string) =>
            mode !== 'search' && chosen.has(decode(target))
              ? whole
              : `${prefix}#/questions?search=${encodeURIComponent(decode(target))}`,
        );
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return visit(value) as T;
}

/** A build shares one taxonomy/asset cache across every domain and part. */
export function contentExportContext(
  store: Store,
  taxonomy?: { domains: Domain[]; categories: Category[]; tags: Tag[] },
) {
  const domains = new Map(
    (taxonomy?.domains || store.all<Domain>('domains')).map((value) => [value.id, value]),
  );
  const categories = new Map(
    (taxonomy?.categories || store.all<Category>('categories')).map((value) => [value.id, value]),
  );
  const tags = new Map(
    (taxonomy?.tags || store.all<Tag>('tags')).map((value) => [value.id, value]),
  );
  const assets = new Map<string, AssetRecord>();
  const requireValue = <T>(values: Map<string, T>, id: string, label: string) =>
    values.get(id) || fail(422, 'INCOMPLETE_CONTENT_EXPORT', `导出依赖缺失：${label} ${id}`);
  return {
    dependencies(questions: Question[], extra: unknown = null, extraDomainIds: string[] = []) {
      const categoryIds = new Set(questions.flatMap((question) => question.categoryIds));
      for (const cid of categoryIds) {
        let current = requireValue(categories, cid, '分类');
        const seen = new Set([cid]);
        while (current.parentId) {
          if (seen.has(current.parentId)) fail(422, 'CATEGORY_CYCLE', '分类不能形成环');
          seen.add(current.parentId);
          categoryIds.add(current.parentId);
          current = requireValue(categories, current.parentId, '父分类');
        }
      }
      const chosenCategories = [...categoryIds]
        .sort()
        .map((id) => requireValue(categories, id, '分类'));
      const tagIds = new Set(questions.flatMap((question) => question.tagIds));
      const chosenTags = [...tagIds].sort().map((id) => requireValue(tags, id, '标签'));
      const domainIds = new Set([
        ...chosenCategories.map((value) => value.domainId),
        ...chosenTags.flatMap((value) => (value.domainId ? [value.domainId] : [])),
        ...extraDomainIds,
      ]);
      const chosenAssets = [...collectAssetReferences({ questions, extra })].sort().map((id) => {
        if (!assets.has(id)) {
          const asset =
            store.get<AssetRecord>('assets', id) ||
            fail(422, 'INCOMPLETE_CONTENT_EXPORT', `导出依赖缺失：附件 ${id}`);
          validateAssetRecord(asset);
          assets.set(id, asset);
        }
        return assets.get(id)!;
      });
      return {
        domains: [...domainIds].sort().map((id) => requireValue(domains, id, '领域')),
        categories: chosenCategories,
        tags: chosenTags,
        assets: chosenAssets,
      };
    },
  };
}
