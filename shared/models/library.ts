import type { Category, DocumentRecord } from './types.js';

/** Content type is independent of its file format and subject taxonomy. */
export const documentKinds = ['书籍', '学习笔记', '学习路线', '参考资料', '项目资料'] as const;
export function documentDomainIds(document: DocumentRecord, categories: Category[]): string[] {
  return [...new Set([...(document.domainIds || []), ...categories.filter(category => document.categoryIds.includes(category.id)).map(category => category.domainId)])];
}
export function categoryPath(category: Category, categories: Category[]): string {
  const names = [category.name]; const seen = new Set([category.id]); let parent = category.parentId;
  while (parent && !seen.has(parent)) { seen.add(parent); const item = categories.find(value => value.id === parent); if (!item) break; names.unshift(item.name); parent = item.parentId; }
  return names.join(' / ');
}
