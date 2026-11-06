import { useState } from 'react';
import type {
  ImportTaxonomyCatalog,
  ImportTaxonomyMapping,
} from '../../../shared/models/import-taxonomy';
import {
  changeImportMapping,
  importMappingEntry,
  importMappingTargets,
  type ImportTaxonomyKind,
} from '../lib/import-taxonomy-state';
import { usePagination } from '../lib/pagination';
import { Pagination, SearchBox } from './components';
import './import-taxonomy-mapping.css';

const labels: Record<ImportTaxonomyKind, string> = {
  domains: '领域',
  categories: '分类',
  tags: '标签',
};
type Props = {
  source: ImportTaxonomyCatalog;
  local: ImportTaxonomyCatalog;
  value: ImportTaxonomyMapping;
  onChange: (value: ImportTaxonomyMapping) => void;
  disabled?: boolean;
};

function MappingRow({
  kind,
  sourceId,
  source,
  local,
  value,
  onChange,
  disabled,
}: Props & { kind: ImportTaxonomyKind; sourceId: string }) {
  const original = source[kind].find((row) => row.id === sourceId)!;
  const entry = importMappingEntry(value, kind, sourceId);
  const mode =
    entry?.targetId !== undefined ? 'target' : entry?.name !== undefined ? 'rename' : 'default';
  const [search, setSearch] = useState('');
  const targets = importMappingTargets(kind, sourceId, source, local, value);
  const query = search.trim().toLocaleLowerCase();
  const found = targets.filter(
    (row) => !query || `${row.name} ${row.id}`.toLocaleLowerCase().includes(query),
  );
  const selected = targets.find((row) => row.id === entry?.targetId);
  const displayed = found.slice(0, 50);
  if (selected && !displayed.some((row) => row.id === selected.id)) displayed.unshift(selected);
  const field = `${labels[kind]} ${original.name}`;
  const change = (choice?: { targetId?: string; name?: string }) =>
    onChange(changeImportMapping(value, kind, sourceId, choice));
  const domainId = 'domainId' in original ? original.domainId : null;
  const sourceDomain = source.domains.find((row) => row.id === domainId)?.name;
  return (
    <article className="import-mapping-row" data-source-taxonomy={`${kind}:${sourceId}`}>
      <div>
        <strong>{original.name}</strong>
        <small>
          {sourceDomain || (kind === 'tags' ? '通用标签' : labels[kind])} · {original.id}
        </small>
      </div>
      <label className="import-mapping-field">
        <span className="sr-only">{field}处理方式</span>
        <select
          aria-label={`${field}处理方式`}
          value={mode}
          disabled={disabled}
          onChange={(event) => {
            setSearch('');
            change(
              event.target.value === 'target'
                ? { targetId: '' }
                : event.target.value === 'rename'
                  ? { name: original.name }
                  : undefined,
            );
          }}
        >
          <option value="default">沿用来源名称和默认匹配</option>
          <option value="target">映射到本地已有项</option>
          <option value="rename">使用新名称导入</option>
        </select>
      </label>
      {mode === 'rename' && (
        <label className="import-mapping-field">
          <span className="sr-only">{field}导入名称</span>
          <input
            aria-label={`${field}导入名称`}
            maxLength={160}
            value={entry?.name || ''}
            disabled={disabled}
            onChange={(event) => change({ name: event.target.value })}
          />
        </label>
      )}
      {mode === 'target' && (
        <div className="import-mapping-target">
          <label className="import-mapping-field">
            <span className="sr-only">{field}搜索本地目标</span>
            <input
              type="search"
              aria-label={`${field}搜索本地目标`}
              value={search}
              disabled={disabled}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索本地名称或ID"
            />
          </label>
          <label className="import-mapping-field">
            <span className="sr-only">{field}本地目标</span>
            <select
              aria-label={`${field}本地目标`}
              value={entry?.targetId || ''}
              disabled={disabled}
              onChange={(event) => change({ targetId: event.target.value })}
            >
              <option value="">请选择本地目标</option>
              {entry?.targetId && !selected && (
                <option value={entry.targetId} disabled>
                  原选择不再适用，请重新选择
                </option>
              )}
              {displayed.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {row.id}
                </option>
              ))}
            </select>
          </label>
          {!targets.length && (
            <small className="muted">
              没有可用目标；如需合并所属分类，请先将来源领域映射到本地领域。
            </small>
          )}
          {found.length > 50 && (
            <small className="muted">仅列出前50个匹配项，请输入更具体的名称或ID。</small>
          )}
        </div>
      )}
    </article>
  );
}

/** Source metadata is paged, and target choices are searched before rendering
 * a bounded option list. Large imported taxonomies never create an N² DOM. */
export function ImportTaxonomyMappingEditor(props: Props) {
  const { source, value, onChange, disabled = false } = props;
  const [kind, setKind] = useState<ImportTaxonomyKind>('domains');
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const list = source[kind].filter(
    (row) => !query || `${row.name} ${row.id}`.toLocaleLowerCase().includes(query),
  );
  const paging = usePagination(list, kind + ':' + search, 10);
  const choices = ['domains', 'categories', 'tags'] as const;
  const changed = choices.reduce((sum, key) => sum + (value[key]?.length || 0), 0);
  return (
    <details className="import-taxonomy-mapping">
      <summary>领域、分类与标签映射（可选{changed ? `，已调整${changed}项` : ''}）</summary>
      <div className="ui-stack">
        <p className="muted">
          来源名称不同但表示同一领域时，可映射到本地已有项；也可使用新名称。先确定领域，再调整所属分类和标签。修改后需重新预览，不会直接改动本地归类。
        </p>
        <nav className="import-mapping-tabs" role="tablist" aria-label="导入知识归属类型">
          {choices.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={kind === key}
              className={kind === key ? 'selected' : ''}
              disabled={disabled}
              onClick={() => {
                setKind(key);
                setSearch('');
              }}
            >
              {labels[key]}（{source[key].length.toLocaleString()}）
            </button>
          ))}
        </nav>
        <SearchBox value={search} onChange={setSearch} placeholder="搜索来源名称或ID" />
        <div className="import-mapping-rows">
          {paging.items.map((row) => (
            <MappingRow
              {...props}
              disabled={disabled}
              kind={kind}
              sourceId={row.id}
              key={`${kind}:${row.id}`}
            />
          ))}
          {!list.length && <p className="muted">没有匹配的来源项。</p>}
        </div>
        <Pagination {...paging} label="导入归属" />
        {changed > 0 && (
          <div>
            <button
              type="button"
              className="button"
              disabled={disabled}
              onClick={() => onChange({})}
            >
              清除归属调整
            </button>
          </div>
        )}
        <small className="muted">
          映射保留本地目标的名称与层级；使用新名称时保留来源分类关系。跨领域分类不会混合，领域标签也只显示匹配领域或通用标签。
        </small>
      </div>
    </details>
  );
}
