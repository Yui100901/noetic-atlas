import { useEffect, useState } from 'react';
import { CheckSquare, Share2 } from 'lucide-react';
import type { PaperListPage } from '../../../shared/practice/paper-list';
import { qs, useDebounced, useResource } from '../../shared/lib/api';
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Pagination,
  SearchBox,
  useApp,
} from '../../shared/ui/components';
import { ShareButton } from './share-button';

export function PaperSharing() {
  const { bootstrap } = useApp();
  const [search, setSearch] = useState(''),
    [organization, setOrganization] = useState('all'),
    [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20),
    [selected, setSelected] = useState<string[]>([]);
  const searchValue = useDebounced(search);
  const filters = {
    search: searchValue,
    organization: organization.startsWith('domain:') ? 'domain' : organization,
    domainId: organization.startsWith('domain:') ? organization.slice(7) : undefined,
    archived: String(archived),
  };
  const url = '/api/papers/page?' + qs({ ...filters, page, pageSize }),
    resource = useResource<PaperListPage>(url);
  const current = resource.dataUrl === url,
    data = current ? resource.data : null,
    loading = resource.loading || (!current && !resource.error);
  const ids = (data?.items || []).map((paper) => paper.id);
  useEffect(() => {
    if (data && data.page !== page) setPage(data.page);
  }, [data, page]);
  const toggle = (id: string, checked: boolean) =>
    setSelected((values) => (checked ? [...values, id] : values.filter((value) => value !== id)));
  return (
    <section className="paper-sharing ui-stack" aria-label="筛选与批量分享题集">
      <div>
        <h2>题集分享</h2>
        <p className="muted">
          筛选题集后跨页勾选，或分享全部筛选结果。ZIP保留各题集的题目快照、计分和判题要求，接收方一次导入。
        </p>
      </div>
      <div className="filter-bar">
        <SearchBox
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="搜索题集标题"
        />
        <Field label="题集归属">
          <select
            value={organization}
            onChange={(event) => {
              setOrganization(event.target.value);
              setPage(1);
            }}
          >
            <option value="all">全部归属</option>
            {bootstrap.domains.map((domain) => (
              <option key={domain.id} value={'domain:' + domain.id}>
                {domain.name}专项
              </option>
            ))}
            <option value="other">其他题集</option>
          </select>
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => {
              setArchived(event.target.checked);
              setPage(1);
            }}
          />
          包含已归档
        </label>
      </div>
      <div className="paper-sharing-actions">
        <span>
          筛选 {data?.total.toLocaleString() || '—'} 份 · 已选 {selected.length} 份（跨页保留）
        </span>
        <div className="button-row">
          <button
            className="button"
            disabled={
              !ids.length ||
              selected.length + ids.filter((id) => !selected.includes(id)).length > 100
            }
            onClick={() => setSelected((values) => [...new Set([...values, ...ids])])}
          >
            <CheckSquare size={16} />
            选择当前页
          </button>
          <button className="button" disabled={!selected.length} onClick={() => setSelected([])}>
            清空选择
          </button>
          {selected.length > 0 && (
            <ShareButton kind="paper" ids={selected} label={`分享已选 ${selected.length} 份`} />
          )}
          <ShareFiltered
            total={data?.total || 0}
            filters={filters}
            disabled={loading || search !== searchValue || !!resource.error}
          />
        </div>
      </div>
      {selected.length > 100 && <ErrorNotice message="一次最多分享100份题集，请减少选择。" />}
      {(data?.total || 0) > 100 && (
        <p className="notice info">
          全部筛选结果超过100份，请缩小筛选范围或跨页选择最多100份题集。每次生成文件前还会检查题量和容量。
        </p>
      )}
      {loading ? (
        <Loading text="正在筛选题集…" />
      ) : resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.refresh} />
      ) : data?.items.length ? (
        <div className="paper-sharing-list">
          {data.items.map((paper) => (
            <label className="card paper-sharing-row" key={paper.id}>
              <input
                type="checkbox"
                aria-label={'选择分享题集：' + paper.title}
                checked={selected.includes(paper.id)}
                disabled={!selected.includes(paper.id) && selected.length >= 100}
                onChange={(event) => toggle(paper.id, event.target.checked)}
              />
              <span>
                <strong>{paper.title}</strong>
                <small>
                  {paper.questionCount.toLocaleString()} 道题 · v{paper.version} ·{' '}
                  {paper.organization === 'domain'
                    ? bootstrap.domains.find((domain) => domain.id === paper.domainId)?.name ||
                      '领域专项'
                    : '其他题集'}
                  {paper.archived ? ' · 已归档' : ''}
                </small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <Empty title="没有符合条件的题集" description="调整标题、领域或归档条件。" />
      )}
      {data && (
        <Pagination
          page={data.page}
          pageSize={pageSize}
          total={data.total}
          onPage={setPage}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          label="可分享题集"
        />
      )}
    </section>
  );
}
function ShareFiltered({
  total,
  filters,
  disabled,
}: {
  total: number;
  filters: Record<string, unknown>;
  disabled: boolean;
}) {
  return total > 0 && total <= 100 && !disabled ? (
    <ShareButton kind="paper" filters={filters} label={`分享全部筛选结果 ${total} 份`} />
  ) : (
    <button className="button" disabled>
      <Share2 size={16} />
      分享全部筛选结果
    </button>
  );
}
