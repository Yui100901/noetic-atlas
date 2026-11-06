import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Check, Upload } from 'lucide-react';
import type { DataPackagePreview } from '../../../shared/models/data-packages';
import type { ImportDedupDecision } from '../../../shared/models/import-dedup';
import type { QuestionInput } from '../../../shared/models/types';
import { unresolvedImportItems } from '../lib/import-review-state';
import { ImportDedupReview } from './import-dedup-review';
import { readPackageFile } from '../lib/data-package';
import { ApiError, request } from '../lib/api';
import { ErrorNotice, useApp } from './components';
import { DataPackagePreviewBody } from './data-package-preview';
import './data-package-import.css';

/** One file reader and one whole-package commit for all structured transfers.
 * Stale reads and requests cannot restore an older selection or enable import. */
export function DataPackageImport({
  title = '导入数据包',
  description,
  onImported,
  preparedFile,
  purpose,
}: {
  title?: string;
  description?: string;
  onImported?: () => void;
  preparedFile?: File | null;
  purpose?: 'content' | 'configuration';
}) {
  const { reload, toast } = useApp();
  const [filename, setFilename] = useState(''),
    [encoded, setEncoded] = useState('');
  const [preview, setPreview] = useState<DataPackagePreview | null>(null);
  const [phase, setPhase] = useState<'reading' | 'preview' | 'import' | null>(null);
  const [error, setError] = useState(''),
    [done, setDone] = useState<DataPackagePreview['kind'] | null>(null);
  const [trusted, setTrusted] = useState(false),
    [retention, setRetention] = useState(false);
  const [decisions, setDecisions] = useState<ImportDedupDecision[]>([]);
  const unresolved = preview?.dedup ? unresolvedImportItems(preview.dedup, decisions).length : 0;
  const misplaced =
    preview &&
    ((purpose === 'content' && preview.kind === 'configuration') ||
      (purpose === 'configuration' && preview.kind !== 'configuration'));
  const readIncoming = useCallback(
    (index: number, signal?: AbortSignal) =>
      request<QuestionInput>(
        `/api/packages/import-question?fingerprint=${encodeURIComponent(preview?.fingerprint || '')}&index=${index}`,
        { signal },
      ),
    [preview?.fingerprint],
  );
  const generation = useRef(0),
    active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      active.current?.abort();
    },
    [],
  );
  const load = async (file?: File) => {
    if (!file || phase === 'import') return;
    const version = ++generation.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const current = () => version === generation.current && !controller.signal.aborted;
    setPhase('reading');
    setPreview(null);
    setEncoded('');
    setError('');
    setDone(null);
    setTrusted(false);
    setRetention(false);
    setDecisions([]);
    setFilename(file.name);
    try {
      const dataBase64 = await readPackageFile(file);
      if (!current()) return;
      setEncoded(dataBase64);
      setPhase('preview');
      const result = await request<DataPackagePreview>('/api/packages/preview', {
        method: 'POST',
        body: JSON.stringify({ dataBase64 }),
        signal: controller.signal,
      });
      if (current()) setPreview(result);
    } catch (reason) {
      if (current()) setError((reason as Error).message);
    } finally {
      if (current()) {
        setPhase(null);
        active.current = null;
      }
    }
  };
  useEffect(() => {
    if (preparedFile) void load(preparedFile);
  }, [preparedFile]);
  const inspectAgain = async () => {
    if (!encoded || phase) return;
    const version = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setPhase('preview');
    setTrusted(false);
    setRetention(false);
    setDecisions([]);
    try {
      const result = await request<DataPackagePreview>('/api/packages/preview', {
        method: 'POST',
        body: JSON.stringify({ dataBase64: encoded }),
        signal: controller.signal,
      });
      if (version === generation.current && !controller.signal.aborted) setPreview(result);
    } catch (reason) {
      if (version === generation.current && !controller.signal.aborted)
        setError((reason as Error).message);
    } finally {
      if (version === generation.current) {
        setPhase(null);
        active.current = null;
      }
    }
  };
  const apply = async () => {
    if (
      !preview ||
      !encoded ||
      misplaced ||
      phase ||
      unresolved > 0 ||
      (preview.kind === 'migration' && !trusted) ||
      ((preview.details?.retention.total || 0) > 0 && !retention)
    )
      return;
    const version = ++generation.current;
    setPhase('import');
    setError('');
    try {
      await request('/api/packages/import', {
        method: 'POST',
        body: JSON.stringify({
          dataBase64: encoded,
          expectedFingerprint: preview.fingerprint,
          confirmed: true,
          ...(preview.dedup ? { decisions } : {}),
          ...(trusted ? { confirmedTrusted: true } : {}),
          ...(retention ? { confirmedRetention: true } : {}),
        }),
      });
      if (version !== generation.current) return;
      setDone(preview.kind);
      setEncoded('');
      setPreview(null);
      reload();
      onImported?.();
      toast('数据包已完整导入');
    } catch (reason) {
      if (version === generation.current) {
        if (reason instanceof ApiError && reason.status === 409) {
          setPreview(null);
          setTrusted(false);
          setRetention(false);
        }
        setError((reason as Error).message);
      }
    } finally {
      if (version === generation.current) setPhase(null);
    }
  };
  return (
    <section className="card form-stack data-package-import" aria-label={title} aria-busy={!!phase}>
      <header className="data-package-heading">
        <Archive size={23} />
        <div>
          <h2>{title}</h2>
          <p className="muted">{description || '选择完整 ZIP 数据包，校验后预览并确认导入。'}</p>
        </div>
      </header>
      <label className="button image-file-picker">
        <Upload size={16} />
        {filename || '选择 ZIP 数据包'}
        <input
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          aria-label="选择 ZIP 数据包"
          disabled={phase === 'import'}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void load(file);
          }}
        />
      </label>
      {phase && (
        <div className="action-row">
          <p role="status">
            {phase === 'reading'
              ? '正在读取数据包…可重新选择其他文件。'
              : phase === 'preview'
                ? '正在校验数据包并检查重复与近似题…'
                : '正在完整导入数据包，请保持当前页面…'}
          </p>
          {phase !== 'import' && (
            <button
              type="button"
              className="button"
              onClick={() => {
                generation.current++;
                active.current?.abort();
                active.current = null;
                setPhase(null);
                setPreview(null);
                setEncoded('');
                setDecisions([]);
              }}
            >
              取消检查
            </button>
          )}
        </div>
      )}
      {error && (
        <>
          <ErrorNotice message={error} />
          {/SQLite|数据库备份|完整数据库/.test(error) && (
            <a className="button" href="#/settings?tab=backup&sub=backup">
              前往完整数据库备份与恢复
            </a>
          )}
        </>
      )}
      {encoded && !preview && !phase && (
        <button className="button" onClick={() => void inspectAgain()}>
          重新预览数据包
        </button>
      )}
      {done && (
        <div className="notice success" role="status">
          <Check size={17} />
          数据包已完整导入。
          {(done === 'share' || done === 'question-template' || done === 'question-update') &&
            '题目仍需在审核管理中确认。'}
        </div>
      )}
      {misplaced && (
        <div className="notice info" role="status">
          <p>
            {preview?.kind === 'configuration'
              ? '这是系统配置包。请在配置迁移中核对偏好差异后应用，不会作为题库内容导入。'
              : '这是内容或备份包。请在分享与导入中预览并合并；配置迁移只接收配置包。'}
          </p>
          <a
            className="button"
            href={
              preview?.kind === 'configuration'
                ? '#/settings?tab=backup&sub=configuration'
                : '#/sharing?tab=package'
            }
          >
            {preview?.kind === 'configuration' ? '前往配置迁移' : '前往分享与导入'}
          </a>
        </div>
      )}
      {preview && !misplaced && (
        <div className="ui-stack">
          <DataPackagePreviewBody
            preview={preview}
            busy={!!phase}
            trusted={trusted}
            onTrusted={setTrusted}
            retention={retention}
            onRetention={setRetention}
          />
          {preview.dedup && (
            <ImportDedupReview
              preview={preview.dedup}
              decisions={decisions}
              onChange={setDecisions}
              readIncoming={readIncoming}
              disabled={!!phase}
            />
          )}
          <div className="action-row">
            <button
              className="button"
              disabled={!!phase}
              onClick={() => {
                generation.current++;
                setPreview(null);
                setEncoded('');
                setFilename('');
                setError('');
              }}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={
                !!phase ||
                unresolved > 0 ||
                (preview.kind === 'migration' && !trusted) ||
                ((preview.details?.retention.total || 0) > 0 && !retention)
              }
              onClick={() => void apply()}
            >
              确认导入整个数据包
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
