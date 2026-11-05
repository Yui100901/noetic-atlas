import { useEffect, useRef, useState } from 'react';
import { Download, Eye, LoaderCircle, X } from 'lucide-react';
import { isNativeApp, saveGeneratedFile } from '@platform';
import type {
  ContentExportFile,
  ContentExportPreview,
  ContentExportScope,
} from '../../../shared/models/domain-exports';
import { ApiError, request } from '../../shared/lib/api';
import {
  ErrorNotice,
  Field,
  Loading,
  Pagination,
  SearchBox,
  useApp,
} from '../../shared/ui/components';
import {
  contentExportDefaults,
  contentExportKey,
  exportFileBytes,
  portableExportFilename,
  readableExportBytes,
} from './domain-export-state';
import './domain-export.css';

const statusLabels = {
  all: '所有审核状态',
  published: '已通过审核',
  pending: '待审核',
  draft: '草稿',
  archived: '已归档',
};
const collectionLabels = { all: '通用与个人专项', general: '仅通用题目', personal: '仅个人专项' };
const initialScope: ContentExportScope = {
  domainIds: [],
  mode: 'combined',
  ...contentExportDefaults('migration'),
};

export function DomainExport() {
  const { bootstrap, toast } = useApp();
  const [scope, setScope] = useState(initialScope);
  const key = contentExportKey(scope);
  const scopeKey = `${scope.purpose}:${scope.status}:${scope.collection}`;
  const [catalog, setCatalog] = useState<
    (Pick<ContentExportPreview, 'domains' | 'limits'> & { key: string }) | null
  >(null);
  const [catalogLoading, setCatalogLoading] = useState(true),
    [catalogError, setCatalogError] = useState('');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(12);
  const [preview, setPreview] = useState<{ key: string; data: ContentExportPreview } | null>(null);
  const [error, setError] = useState(''),
    [phase, setPhase] = useState<'preview' | 'generating' | 'saving' | null>(null);
  const [completion, setCompletion] = useState('');
  const active = useRef<{ controller: AbortController; key: string; token: number } | null>(null);
  const generation = useRef(0),
    currentKey = useRef(key),
    alive = useRef(true);
  currentKey.current = key;
  const saving = phase === 'saving';
  const currentPreview = preview?.key === key ? preview.data : null;

  const invalidate = () => {
    generation.current++;
    active.current?.controller.abort();
    active.current = null;
    setPreview(null);
    setPhase(null);
    setError('');
    setCompletion('');
  };
  const change = (patch: Partial<ContentExportScope>) => {
    if (saving) return;
    invalidate();
    setScope((old) => ({ ...old, ...patch }));
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      active.current?.controller.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    invalidate();
    setCatalogLoading(true);
    setCatalogError('');
    void request<ContentExportPreview>('/api/content-exports/preview', {
      method: 'POST',
      body: JSON.stringify({ ...scope, domainIds: [] }),
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted)
          setCatalog({ key: scopeKey, domains: data.domains, limits: data.limits });
      })
      .catch((err) => {
        if (!controller.signal.aborted) setCatalogError((err as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
    // Domain selection and output format do not change catalog counts.
  }, [scopeKey, catalogRevision, bootstrap]);

  const perform = async (build: boolean) => {
    if (phase || !scope.domainIds.length || (build && !currentPreview)) return;
    const controller = new AbortController(),
      token = ++generation.current;
    active.current = { controller, token, key };
    const isCurrent = () =>
      alive.current &&
      !controller.signal.aborted &&
      generation.current === token &&
      currentKey.current === key;
    setError('');
    setCompletion('');
    setPhase(build ? 'generating' : 'preview');
    try {
      if (!build) {
        const data = await request<ContentExportPreview>('/api/content-exports/preview', {
          method: 'POST',
          body: JSON.stringify(scope),
          signal: controller.signal,
        });
        if (isCurrent()) {
          setPreview({ key, data });
          setCatalog({ key: scopeKey, domains: data.domains, limits: data.limits });
        }
      } else {
        const file = await request<ContentExportFile>('/api/content-exports', {
          method: 'POST',
          body: JSON.stringify({ ...scope, expectedFingerprint: currentPreview!.fingerprint }),
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        if (file.mimeType !== 'application/zip')
          throw new Error('导出文件格式与所选格式不一致，请重新预览。');
        const bytes = exportFileBytes(file, currentPreview!.limits.maxPackageBytes);
        if (!isCurrent()) return;
        setPhase('saving');
        const filename = portableExportFilename(file.filename, file.mimeType);
        await saveGeneratedFile(filename, bytes, file.mimeType);
        if (!isCurrent()) return;
        const message = `${file.summary.questionCount.toLocaleString()} 道题 · ${file.summary.domainCount} 个领域 · ${file.summary.fileCount} 份题库文件`;
        setCompletion(`${isNativeApp() ? '导出文件已准备' : '已下载'}：${message}`);
        toast(isNativeApp() ? '题库文件已准备，可在系统面板保存或分享' : '题库导出已下载');
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && /FINGERPRINT|CHANGED|STALE/.test(err.code || ''))
        setPreview(null);
      setError((err as Error).message || '导出失败，请重试。');
    } finally {
      if (isCurrent()) {
        active.current = null;
        setPhase(null);
      }
    }
  };
  const domains = catalog?.key === scopeKey ? catalog.domains : [];
  const filtered = domains.filter((domain) =>
    domain.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize)),
    visiblePage = Math.min(page, pages);
  const visibleDomains = filtered.slice((visiblePage - 1) * pageSize, visiblePage * pageSize);
  const selected = new Set(scope.domainIds);
  const exceedsLimit =
    !!currentPreview && currentPreview.questionCount > currentPreview.limits.maxQuestions;

  return (
    <section
      className="card settings-section domain-export"
      aria-labelledby="domain-export-title"
      aria-busy={!!phase}
    >
      <header className="domain-export-heading">
        <div>
          <h2 id="domain-export-title">按领域导出题库</h2>
          <p className="muted">选择一个或多个领域，将题目、分类、标签与题目图片一起带走。</p>
        </div>
      </header>
      <fieldset className="domain-export-purpose" disabled={saving}>
        <legend>导出用途</legend>
        {(
          [
            ['migration', '迁移题库', '保留题目审核状态，默认包含个人专项。'],
            ['share', '分享题库', '默认仅分享通用已审核题，接收方导入后待审核。'],
          ] as const
        ).map(([value, title, description]) => (
          <label
            key={value}
            className={`domain-export-choice ${scope.purpose === value ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="content-export-purpose"
              value={value}
              checked={scope.purpose === value}
              onChange={() => change(contentExportDefaults(value))}
            />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="notice info domain-export-privacy">
        仅导出题库内容，不含作答记录、笔记或系统配置。教材原文件不包含在内，题目引用信息保留；完整恢复请使用数据库备份。
      </p>
      <div className="domain-export-scope">
        <span>
          当前范围：<strong>{statusLabels[scope.status]}</strong> ·{' '}
          {collectionLabels[scope.collection]}
        </span>
        <details className="domain-export-advanced">
          <summary>调整导出范围</summary>
          <div className="domain-export-filters">
            <Field label="审核状态">
              <select
                disabled={saving}
                value={scope.status}
                onChange={(event) =>
                  change({ status: event.target.value as ContentExportScope['status'] })
                }
              >
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="内容属性">
              <select
                disabled={saving}
                value={scope.collection}
                onChange={(event) =>
                  change({ collection: event.target.value as ContentExportScope['collection'] })
                }
              >
                {Object.entries(collectionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <small className="muted">切换导出用途会恢复该用途的默认范围，已选领域会保留。</small>
        </details>
      </div>
      <div className="domain-export-domain-heading">
        <h3>
          选择领域 <span className="muted">已选 {scope.domainIds.length} 个</span>
        </h3>
        <div className="domain-export-selection-actions">
          <button
            type="button"
            className="button"
            disabled={saving || catalogLoading || !domains.length}
            onClick={() => change({ domainIds: domains.map((domain) => domain.id) })}
          >
            全选领域
          </button>
          <button
            type="button"
            className="button"
            disabled={saving || !scope.domainIds.length}
            onClick={() => change({ domainIds: [] })}
          >
            清空选择
          </button>
        </div>
      </div>
      <SearchBox
        value={search}
        onChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="搜索导出领域"
      />
      {catalogLoading ? (
        <Loading text="正在统计各领域题量…" />
      ) : catalogError ? (
        <ErrorNotice
          message={catalogError}
          retry={() => setCatalogRevision((value) => value + 1)}
        />
      ) : (
        <>
          <div className="domain-export-domain-list" role="group" aria-label="导出领域">
            {visibleDomains.map((domain) => (
              <label
                key={domain.id}
                className={`domain-export-domain ${selected.has(domain.id) ? 'selected' : ''}`}
              >
                <input
                  type="checkbox"
                  disabled={saving}
                  checked={selected.has(domain.id)}
                  onChange={() =>
                    change({
                      domainIds: selected.has(domain.id)
                        ? scope.domainIds.filter((id) => id !== domain.id)
                        : [...scope.domainIds, domain.id],
                    })
                  }
                />
                <span>{domain.name}</span>
                <small>{domain.questionCount.toLocaleString()} 题</small>
              </label>
            ))}
            {!filtered.length && (
              <p className="muted">
                {domains.length
                  ? '没有匹配的领域，可修改搜索词。'
                  : '暂无领域，请先添加领域或导入题库。'}
              </p>
            )}
          </div>
          {domains.length > 12 && (
            <Pagination
              label="导出领域"
              total={filtered.length}
              page={visiblePage}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={(value) => {
                setPageSize(value);
                setPage(1);
              }}
            />
          )}
        </>
      )}
      <fieldset className="domain-export-formats" disabled={saving}>
        <legend>文件组织</legend>
        {(
          [
            [
              'combined',
              '合并为一个数据包（ZIP）',
              '多个领域合并去重，通过manifest一次导入全部内容。',
            ],
            [
              'per_domain',
              '数据包内按领域分组',
              '包内按领域与分片组织，导入时解析manifest，整包一次完成。',
            ],
          ] as const
        ).map(([value, title, description]) => (
          <label
            key={value}
            className={`domain-export-choice ${scope.mode === value ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="content-export-mode"
              value={value}
              checked={scope.mode === value}
              onChange={() => change({ mode: value })}
            />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {currentPreview && (
        <section className="domain-export-preview" aria-label="导出预览">
          <h3>导出预览</h3>
          <div className="domain-export-metrics">
            <div>
              <strong>{currentPreview.questionCount.toLocaleString()}</strong>
              <span>道题（去重）</span>
            </div>
            <div>
              <strong>{currentPreview.selectedDomains.length}</strong>
              <span>个领域</span>
            </div>
            <div>
              <strong>{currentPreview.categories}</strong>
              <span>个分类</span>
            </div>
            <div>
              <strong>{currentPreview.tags}</strong>
              <span>个标签</span>
            </div>
          </div>
          <ul className="domain-export-domain-summary">
            {currentPreview.selectedDomains.map((domain) => (
              <li key={domain.id}>
                <span>{domain.name}</span>
                <strong>{domain.questionCount.toLocaleString()} 题</strong>
              </li>
            ))}
          </ul>
          <p className="muted">
            题目正文约 {readableExportBytes(currentPreview.estimatedQuestionBytes)}
            ，图片将在生成时加入。
            {scope.purpose === 'migration'
              ? '导入时保留原审核状态与内容属性。'
              : '接收方导入后，所有题目进入待审核。'}
          </p>
          {currentPreview.emptyDomainIds.length > 0 && (
            <p className="notice warning">
              所选领域中有 {currentPreview.emptyDomainIds.length}{' '}
              个在当前范围内没有题目，将不生成空题库文件。
            </p>
          )}
          {currentPreview.memberships > currentPreview.questionCount && (
            <p className="notice info">
              有 {(currentPreview.memberships - currentPreview.questionCount).toLocaleString()}{' '}
              次跨领域重复归属。合并时去重，按领域导出时分别收录。
            </p>
          )}
          {!!currentPreview.warnings.length && (
            <details className="domain-export-notes">
              <summary>导出依赖与导入说明</summary>
              <ul>
                {currentPreview.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {exceedsLimit && (
            <p className="notice error">
              本次超过 {currentPreview.limits.maxQuestions.toLocaleString()}{' '}
              道题的上限，请减少所选领域。
            </p>
          )}
        </section>
      )}
      {error && <ErrorNotice message={error} />}
      {completion && (
        <p className="notice success" role="status">
          {completion}
        </p>
      )}
      <div className="domain-export-actions">
        <button
          type="button"
          className="button"
          disabled={!scope.domainIds.length || !!phase || catalogLoading || !!catalogError}
          onClick={() => void perform(false)}
        >
          <Eye size={17} />
          预览导出内容
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!currentPreview || !currentPreview.questionCount || exceedsLimit || !!phase}
          onClick={() => void perform(true)}
        >
          <Download size={17} />
          生成并下载 ZIP
        </button>
        {phase && (
          <span role="status" className="domain-export-work">
            <LoaderCircle size={17} className="spin" />
            {phase === 'preview'
              ? '正在核对导出范围…'
              : phase === 'generating'
                ? '正在整理题目与图片，请稍候…'
                : '正在保存文件…'}
          </span>
        )}
        {phase && !saving && (
          <button type="button" className="button" onClick={invalidate}>
            <X size={16} />
            取消等待
          </button>
        )}
      </div>
      {!currentPreview && !phase && (
        <small className="muted">
          选择领域后先预览；更改范围或文件组织后，需要重新预览再下载。
        </small>
      )}
    </section>
  );
}
