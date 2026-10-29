import { useId, useState } from 'react';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import type { Bootstrap } from '../../../shared/models/types';
import { categoryPath, documentKinds } from '../../../shared/models/library';
import { SearchBox } from '../../shared/ui/components';
import type { DocumentListLocation } from './document-navigation';
import './document-filters.css';

type Filters = Omit<DocumentListLocation, 'page' | 'pageSize'>;
export function DocumentFilters({
  value,
  onChange,
  kinds,
  bootstrap,
}: {
  value: Filters;
  onChange: (patch: Partial<Filters>) => void;
  kinds: string[];
  bootstrap: Bootstrap;
}) {
  const [expanded, setExpanded] = useState(false),
    panelId = useId();
  const categories = bootstrap.categories.filter(
    (category) => !value.domainId || category.domainId === value.domainId,
  );
  const tags = bootstrap.tags.filter(
    (tag) => !value.domainId || !tag.domainId || tag.domainId === value.domainId,
  );
  const chips: { key: keyof Filters; label: string }[] = [
    ...(value.search ? [{ key: 'search' as const, label: `搜索：${value.search}` }] : []),
    ...(value.domainId
      ? [
          {
            key: 'domainId' as const,
            label: `领域：${bootstrap.domains.find((item) => item.id === value.domainId)?.name || value.domainId}`,
          },
        ]
      : []),
    ...(value.categoryId
      ? [
          {
            key: 'categoryId' as const,
            label: `分类：${bootstrap.categories.find((item) => item.id === value.categoryId)?.name || value.categoryId}`,
          },
        ]
      : []),
    ...(value.kind ? [{ key: 'kind' as const, label: `类型：${value.kind}` }] : []),
    ...(value.collection
      ? [
          {
            key: 'collection' as const,
            label: `属性：${value.collection === 'personal' ? '个人资料' : '通用知识'}`,
          },
        ]
      : []),
    ...(value.tagId
      ? [
          {
            key: 'tagId' as const,
            label: `标签：${bootstrap.tags.find((item) => item.id === value.tagId)?.name || value.tagId}`,
          },
        ]
      : []),
    ...(value.format
      ? [{ key: 'format' as const, label: `格式：${value.format === 'pdf' ? 'PDF' : 'Markdown'}` }]
      : []),
  ];
  const count = ['categoryId', 'kind', 'collection', 'tagId', 'format'].filter(
    (key) => value[key as keyof Filters],
  ).length;
  return (
    <section
      className="filters-panel library-filters library-filter-disclosure"
      aria-label="资料筛选"
    >
      <div className="library-filter-primary">
        <SearchBox
          value={value.search}
          onChange={(search) => onChange({ search })}
          placeholder="搜索标题、作者与资料正文"
        />
        <select
          aria-label="资料领域"
          value={value.domainId}
          onChange={(event) =>
            onChange({ domainId: event.target.value, categoryId: '', tagId: '' })
          }
        >
          <option value="">全部领域</option>
          {bootstrap.domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button library-filter-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((before) => !before)}
        >
          <SlidersHorizontal size={16} />
          高级筛选{count > 0 && <span className="badge">{count}</span>}
          <ChevronDown size={15} className={expanded ? 'rotated' : ''} />
        </button>
      </div>
      <div id={panelId} hidden={!expanded} className="library-filter-advanced">
        <select
          aria-label="资料细分类"
          value={value.categoryId}
          onChange={(event) => onChange({ categoryId: event.target.value })}
        >
          <option value="">全部细分类</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {categoryPath(category, bootstrap.categories)}
            </option>
          ))}
        </select>
        <select
          aria-label="资料类型"
          value={value.kind}
          onChange={(event) => onChange({ kind: event.target.value })}
        >
          <option value="">所有内容类型</option>
          {Array.from(new Set([...documentKinds, ...kinds])).map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
        <select
          aria-label="资料集合"
          value={value.collection}
          onChange={(event) => onChange({ collection: event.target.value })}
        >
          <option value="">全部资料</option>
          <option value="general">通用知识</option>
          <option value="personal">个人资料</option>
        </select>
        <select
          aria-label="资料标签"
          value={value.tagId}
          onChange={(event) => onChange({ tagId: event.target.value })}
        >
          <option value="">全部标签</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </select>
        <select
          aria-label="资料文件格式"
          value={value.format}
          onChange={(event) => onChange({ format: event.target.value })}
        >
          <option value="">全部文件格式</option>
          <option value="markdown">Markdown</option>
          <option value="pdf">PDF</option>
        </select>
      </div>
      {chips.length > 0 && (
        <div className="library-filter-active" aria-label="已生效资料筛选">
          {chips.map((chip) => (
            <button
              type="button"
              className="library-filter-chip"
              key={chip.key}
              aria-label={`移除${chip.label}筛选`}
              onClick={() =>
                onChange(
                  chip.key === 'domainId'
                    ? { domainId: '', categoryId: '', tagId: '' }
                    : { [chip.key]: '' },
                )
              }
            >
              <span>{chip.label}</span>
              <X size={13} />
            </button>
          ))}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              onChange({
                search: '',
                domainId: '',
                categoryId: '',
                kind: '',
                collection: '',
                tagId: '',
                format: '',
              })
            }
          >
            清空筛选
          </button>
        </div>
      )}
    </section>
  );
}
