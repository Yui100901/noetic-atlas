import { useEffect, useState } from 'react';
import type { PdfCache, PdfHit, PdfJob } from '../../../shared/pdf/text';
import { idPath, request, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Pagination } from '../../shared/ui/components';
import { wakePdfIndexer } from './pdf-index-runner';
import './pdf-index.css';
type Job = PdfJob & { cache: PdfCache };
const ocrHint =
  '未提取到可搜索文字，仍可阅读原文件。需要检索时，请用外部 OCR 工具生成带文字层的 PDF，再到资料库上传。';
const labels: Record<PdfJob['status'], string> = {
  queued: '等待索引',
  running: '建立索引中',
  paused: '已暂停',
  complete: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
export function PdfIndexPanel({ assetId }: { assetId?: string }) {
  const jobs = useResource<Job[]>('/api/pdf-index/jobs'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [expanded, setExpanded] = useState<boolean | null>(null);
  useEffect(() => {
    const refresh = () => jobs.refresh();
    window.addEventListener('atlas-pdf-progress', refresh);
    const timer = setInterval(refresh, 5000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('atlas-pdf-progress', refresh);
    };
  }, [jobs.refresh]);
  const list = (jobs.data || []).filter((job) => !assetId || job.assetId === assetId),
    act = async (job: Job, action: string) => {
      setError('');
      try {
        await send(`/api/pdf-index/jobs/${idPath(job.id)}/control`, 'POST', { action });
        window.dispatchEvent(new CustomEvent('atlas-pdf-cancel', { detail: job.id }));
        jobs.refresh();
        wakePdfIndexer();
      } catch (reason) {
        setError((reason as Error).message);
      }
    };
  const queue = async () => {
    setBusy(true);
    setError('');
    try {
      await send('/api/pdf-index/jobs', 'POST', assetId ? { assetId } : { all: true });
      setExpanded(true);
      jobs.refresh();
      wakePdfIndexer();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const current = assetId ? list[0] : undefined,
    needsAttention = list.some((job) => job.status !== 'complete'),
    showDetails = expanded ?? (!!assetId && needsAttention);
  return (
    <section className="pdf-index-panel" aria-label="PDF全文索引">
      <div className="pdf-index-heading">
        <strong>PDF全文检索</strong>
        {(!assetId || !current) && (
          <button type="button" className="button" disabled={busy} onClick={() => void queue()}>
            {assetId ? '建立全文索引' : '为现有PDF建立索引'}
          </button>
        )}
        {current?.status === 'complete' && (
          <span className="muted">
            {current.cache?.status === 'needs_ocr'
              ? '需要OCR'
              : `已索引${current.cache?.pageCount || 0}页`}
          </span>
        )}
        {(!assetId || current) && (
          <button
            type="button"
            className="button"
            onClick={() => setExpanded(!showDetails)}
            aria-expanded={showDetails}
          >
            {showDetails ? '收起任务' : assetId ? '索引详情' : '索引任务'}
          </button>
        )}
      </div>
      {showDetails && (
        <>
          <p className="muted">
            索引在应用保持打开时逐页处理；关闭或切到后台会暂停，下次打开继续。搜索不会临时解析文件。
          </p>
          {list.map((job) => (
            <div className="pdf-index-job" key={job.id}>
              <div>
                <strong>{job.filename}</strong>
                <span role="status">
                  {labels[job.status]} · {job.cache?.processedPages || 0} /{' '}
                  {job.cache?.pageCount || '…'}页
                </span>
                {job.cache?.pageCount > 0 && (
                  <progress
                    aria-label={`${job.filename}索引进度`}
                    value={job.cache.processedPages}
                    max={job.cache.pageCount}
                  />
                )}{' '}
                {job.cache?.status === 'needs_ocr' && <p className="notice info">{ocrHint}</p>}
                {job.cache?.status === 'ready' && job.cache.textPages < job.cache.pageCount && (
                  <p className="muted">
                    其中{job.cache.pageCount - job.cache.textPages}
                    页没有可提取文字，可能是空白页或扫描图片。
                  </p>
                )}
                {job.error && <ErrorNotice message={job.error} />}
              </div>
              <div className="pdf-index-actions">
                {['queued', 'running'].includes(job.status) && (
                  <button className="button" onClick={() => void act(job, 'pause')}>
                    暂停
                  </button>
                )}
                {['paused', 'failed', 'cancelled'].includes(job.status) && (
                  <button className="button" onClick={() => void act(job, 'resume')}>
                    {job.status === 'failed' ? '重试' : '继续'}
                  </button>
                )}
                {['queued', 'running', 'paused'].includes(job.status) && (
                  <button className="button" onClick={() => void act(job, 'cancel')}>
                    取消
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
      {!showDetails && current?.cache?.status === 'needs_ocr' && (
        <p className="notice info">{ocrHint}</p>
      )}
      {(error || jobs.error) && <ErrorNotice message={error || jobs.error} />}
    </section>
  );
}
export interface PdfSearchResult {
  total: number;
  hits: PdfHit[];
  page: number;
  pageSize: number;
  job: PdfJob | null;
  cache: PdfCache | null;
}
export function PdfTextSearch({
  assetId,
  initialQuery = '',
  onHit,
  hitHref,
}: {
  assetId: string;
  initialQuery?: string;
  onHit?: (page: number, query: string) => void;
  hitHref?: (page: number, query: string) => string;
}) {
  const [draft, setDraft] = useState(initialQuery),
    [query, setQuery] = useState(initialQuery),
    [page, setPage] = useState(1),
    [result, setResult] = useState<PdfSearchResult | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0),
    [selected, setSelected] = useState(-1);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('atlas-pdf-progress', refresh);
    return () => window.removeEventListener('atlas-pdf-progress', refresh);
  }, []);
  useEffect(() => {
    if (!query.trim()) {
      setResult(null);
      return;
    }
    let active = true;
    setBusy(true);
    void request<PdfSearchResult>(
      `/api/pdf-index/assets/${idPath(assetId)}/search?${new URLSearchParams({ q: query, page: String(page), pageSize: '10' })}`,
    )
      .then((data) => {
        if (active) {
          setResult(data);
          setError('');
        }
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [assetId, query, page, revision]);
  const select = (index: number) => {
    const hit = result?.hits[index];
    if (hit && onHit) {
      setSelected(index);
      onHit(hit.pageNumber, query);
    }
  };
  return (
    <section className="pdf-text-search" aria-label="PDF全文搜索">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
          setPage(1);
          setSelected(-1);
        }}
      >
        <label>
          在本文中查找
          <input
            type="search"
            value={draft}
            maxLength={100}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="关键词，支持中文和英文"
          />
        </label>
        <button className="button" disabled={busy || !draft.trim()}>
          {busy ? '搜索中…' : '查找原文'}
        </button>
      </form>
      {error && <ErrorNotice message={error} />}{' '}
      {result && (
        <>
          <p className="muted" role="status">
            {!result.job
              ? '请先建立全文索引。'
              : result.cache?.status === 'needs_ocr'
                ? '未提取到可搜索文字，需要OCR。'
                : `${result.total}个匹配页面${result.cache?.status === 'indexing' ? '（正在建立索引，仅显示已处理页面）' : ''}`}
          </p>
          {onHit && result.hits.length > 0 && (
            <div className="pdf-reader-match-nav">
              <button
                type="button"
                className="button"
                disabled={selected <= 0}
                onClick={() => select(selected - 1)}
              >
                上一处匹配页
              </button>
              <span>
                {selected < 0
                  ? '选择匹配页'
                  : `第${(page - 1) * 10 + selected + 1} / ${result.total}处`}
              </span>
              <button
                type="button"
                className="button"
                disabled={selected >= result.hits.length - 1}
                onClick={() => select(selected + 1)}
              >
                下一处匹配页
              </button>
            </div>
          )}
          {result.hits.length > 0 && (
            <ol className="pdf-search-hits">
              {result.hits.map((hit, index) => (
                <li key={hit.pageNumber}>
                  {onHit ? (
                    <button
                      className="pdf-hit"
                      type="button"
                      aria-current={selected === index ? 'location' : undefined}
                      onClick={() => select(index)}
                    >
                      <strong>第{hit.pageNumber}页</strong>
                      <span>{hit.excerpt}</span>
                    </button>
                  ) : (
                    <a className="pdf-hit" href={hitHref?.(hit.pageNumber, query)}>
                      <strong>第{hit.pageNumber}页</strong>
                      <span>{hit.excerpt}</span>
                    </a>
                  )}
                </li>
              ))}
            </ol>
          )}
          <Pagination
            label="原文匹配页面"
            page={page}
            pageSize={10}
            total={result.total}
            onPage={(value) => {
              setPage(value);
              setSelected(-1);
            }}
          />
        </>
      )}
    </section>
  );
}
