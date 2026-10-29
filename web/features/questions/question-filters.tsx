import { useState } from 'react';
import { ChevronDown, Filter, RotateCcw } from 'lucide-react';
import { typeLabels } from '../../../shared/models/types';
import { qs } from '../../shared/lib/api';
import {
  emptyFilters,
  normalizeQuestionFilters,
  type Filters,
} from '../../shared/lib/learning-filters';
import { CategoryOptions, Field, SearchBox, useApp } from '../../shared/ui/components';
import { TagPicker } from '../../shared/ui/tag-picker';

// The library and paper editor share filter UI and query encoding. Shared
// normalizers remain the only source of defaults; this module owns no page state.
export { emptyFilters } from '../../shared/lib/learning-filters';
export type { Filters } from '../../shared/lib/learning-filters';

export function FiltersPanel({
  filters,
  onChange,
  compact = false,
  showCollection = true,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  compact?: boolean;
  showCollection?: boolean;
}) {
  const { bootstrap } = useApp();
  const [expanded, setExpanded] = useState(false);
  const set = (name: keyof Filters, value: any) =>
    onChange({ ...filters, [name]: value, ...(name === 'domainId' ? { categoryId: '' } : {}) });
  const count = Object.entries(filters).filter(
    ([key, value]) =>
      !['search', 'tagMode', ...(!showCollection ? ['collection'] : [])].includes(key) &&
      (Array.isArray(value) ? value.length : value),
  ).length;
  return (
    <div className={`filters-panel ${compact ? 'compact-filters' : ''}`}>
      <div className="filter-primary">
        <SearchBox value={filters.search} onChange={(value) => set('search', value)} />
        <label className="sr-only" htmlFor={`domain-${compact}`}>
          知识领域
        </label>
        <select
          id={`domain-${compact}`}
          value={filters.domainId}
          onChange={(event) => set('domainId', event.target.value)}
        >
          <option value="">所有领域</option>
          {bootstrap.domains.map((domain) => (
            <option key={domain.id} value={domain.id}>
              {domain.name}
            </option>
          ))}
        </select>
        <select
          aria-label="分类"
          value={filters.categoryId}
          onChange={(event) => set('categoryId', event.target.value)}
        >
          <option value="">所有分类（含子类）</option>
          <CategoryOptions
            categories={bootstrap.categories}
            domainId={filters.domainId || undefined}
          />
        </select>
        <button
          className={`button ${expanded ? 'active' : ''}`}
          onClick={() => setExpanded(!expanded)}
          type="button"
          aria-expanded={expanded}
        >
          <Filter size={15} />
          筛选{count > 0 && <span className="count-pill">{count}</span>}
          <ChevronDown size={14} />
        </button>
      </div>
      {expanded && (
        <div className="filter-expanded">
          <div className="filter-grid">
            <Field label="题型">
              <select value={filters.type} onChange={(event) => set('type', event.target.value)}>
                <option value="">所有题型</option>
                {Object.entries(typeLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="难度">
              <select
                value={filters.difficulty}
                onChange={(event) => set('difficulty', event.target.value)}
              >
                <option value="">所有难度</option>
                {[1, 2, 3, 4].map((value) => (
                  <option value={value} key={value}>
                    D{value} · {['基础', '应用', '进阶', '综合'][value - 1]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="深度">
              <select value={filters.depth} onChange={(event) => set('depth', event.target.value)}>
                <option value="">所有深度</option>
                {[1, 2, 3, 4].map((value) => (
                  <option value={value} key={value}>
                    L{value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="常见度">
              <select
                value={filters.frequency}
                onChange={(event) => set('frequency', event.target.value)}
              >
                <option value="">所有常见度</option>
                <option value="0">未标常见度 / 不适用</option>
                <option value="3">F3 · 常见</option>
                <option value="2">F2 · 较少见</option>
                <option value="1">F1 · 拓展</option>
              </select>
            </Field>
            {showCollection && (
              <Field label="内容属性">
                <select
                  value={filters.collection}
                  onChange={(event) => set('collection', event.target.value)}
                >
                  <option value="">通用 + 个人专项</option>
                  <option value="general">通用内容</option>
                  <option value="personal">个人专项</option>
                </select>
              </Field>
            )}
            <Field label="发布状态">
              <select
                value={filters.status}
                onChange={(event) => set('status', event.target.value)}
              >
                <option value="">已发布</option>
                <option value="pending">待审核</option>
                <option value="draft">草稿</option>
                <option value="archived">已归档</option>
                <option value="all">全部状态</option>
              </select>
            </Field>
          </div>
          <div className="tag-filter">
            <TagPicker
              tags={bootstrap.tags}
              domains={bootstrap.domains}
              domainIds={filters.domainId ? [filters.domainId] : undefined}
              values={filters.tagIds}
              onChange={(value) => set('tagIds', value)}
            />
            <Field label="多标签关系">
              <select
                value={filters.tagMode}
                onChange={(event) => set('tagMode', event.target.value)}
              >
                <option value="all">同时包含（AND）</option>
                <option value="any">满足其一（OR）</option>
              </select>
            </Field>
          </div>
          <div className="filter-footer">
            <div className="check-row">
              {(
                [
                  ['favorite', '仅收藏'],
                  ['wrong', '有错题记录'],
                  ['due', '已到复习日期'],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={filters[key]}
                    onChange={(event) => set(key, event.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <button
              className="text-button"
              type="button"
              onClick={() => onChange({ ...emptyFilters })}
            >
              <RotateCcw size={13} />
              重置筛选
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export function questionQuery(filters: Filters, page: number, pageSize = 20) {
  const selection = normalizeQuestionFilters(filters);
  return `/api/questions?${qs({ ...selection, page, pageSize, tagIds: selection.tagIds.join(',') })}`;
}
