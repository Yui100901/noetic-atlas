import type { Domain, Tag } from '../../../shared/models/types';
import { MultiSelect } from './components';

export const tagKindLabels = { topic: '知识主题', method: '思维与应用', custom: '自定义' };
export function tagOptions(tags: Tag[], domains: Domain[], domainIds?: string[], selected: string[] = []) {
  return tags.filter(tag => !tag.domainId || domainIds === undefined || domainIds.includes(tag.domainId) || selected.includes(tag.id)).map(tag => ({
    id: tag.id,
    name: `${tag.domainId ? domains.find(domain => domain.id === tag.domainId)?.name || '领域' : '通用'} · ${tag.name}${tag.domainId && domainIds !== undefined && !domainIds.includes(tag.domainId) ? '（领域不匹配）' : ''}`,
  }));
}
export function TagPicker({ label = '知识标签', tags, domains, domainIds, values, onChange }: { label?: string; tags: Tag[]; domains: Domain[]; domainIds?: string[]; values: string[]; onChange: (values: string[]) => void }) {
  const mismatched = tags.some(tag => values.includes(tag.id) && tag.domainId && domainIds !== undefined && !domainIds.includes(tag.domainId));
  return <div className="scoped-tag-picker"><MultiSelect label={label} options={tagOptions(tags, domains, domainIds, values)} values={values} onChange={onChange} />{mismatched && <p className="danger-text" role="status">已选标签与所属分类领域不匹配，请调整分类或移除对应标签。</p>}</div>;
}
