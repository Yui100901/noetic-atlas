import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Check, Upload } from 'lucide-react';
import type { DataPackagePreview } from '../../../shared/models/data-packages';
import type { ImportDedupDecision } from '../../../shared/models/import-dedup';
import type { QuestionInput } from '../../../shared/models/types';
import type {
  ImportTaxonomyCatalog,
  ImportTaxonomyMapping,
} from '../../../shared/models/import-taxonomy';
import { unresolvedImportItems } from '../lib/import-review-state';
import { importMappingIssue } from '../lib/import-taxonomy-state';
import { ImportDedupReview } from './import-dedup-review';
import { ImportDedupToggle } from './import-dedup-toggle';
import { ImportTaxonomyMappingEditor } from './import-taxonomy-mapping';
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
  const { bootstrap, reload, toast } = useApp();
  const [filename, setFilename] = useState(''),
    [encoded, setEncoded] = useState('');
  const [preview, setPreview] = useState<DataPackagePreview | null>(null);
  const [phase, setPhase] = useState<'reading' | 'preview' | 'import' | null>(null);
  const [error, setError] = useState(''),
    [done, setDone] = useState<DataPackagePreview['kind'] | null>(null);
  const [trusted, setTrusted] = useState(false),
    [retention, setRetention] = useState(false);
  const [decisions, setDecisions] = useState<ImportDedupDecision[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [catalog, setCatalog] = useState<ImportTaxonomyCatalog | null>(null);
  const [mapping, setMapping] = useState<ImportTaxonomyMapping>({});
  const [loadedKind, setLoadedKind] = useState<DataPackagePreview['kind'] | null>(null);
  const [optionsChanged, setOptionsChanged] = useState(false);
  const localTaxonomy: ImportTaxonomyCatalog = {
    domains: bootstrap.domains,
    categories: bootstrap.categories,
    tags: bootstrap.tags,
  };
  const mappingIssue = importMappingIssue(catalog, localTaxonomy, mapping);
  const ordinaryImport =
    !loadedKind || loadedKind === 'share' || loadedKind === 'question-template';
  const unresolved =
    enabled && preview?.dedup ? unresolvedImportItems(preview.dedup, decisions).length : 0;
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
  const invalidateOptions = () => {
    generation.current++;
    active.current?.abort();
    active.current = null;
    setPreview(null);
    setPhase(null);
    setError('');
    setDone(null);
    setTrusted(false);
    setRetention(false);
    setDecisions([]);
    setOptionsChanged(!!encoded);
  };
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
    setCatalog(null);
    setLoadedKind(null);
    setMapping({});
    setOptionsChanged(false);
    setFilename(file.name);
    try {
      const dataBase64 = await readPackageFile(file);
      if (!current()) return;
      setEncoded(dataBase64);
      setPhase('preview');
      const result = await request<DataPackagePreview>('/api/packages/preview', {
        method: 'POST',
        body: JSON.stringify({ dataBase64, dedup: { enabled } }),
        signal: controller.signal,
      });
      if (current()) {
        setPreview(result);
        setLoadedKind(result.kind);
        setCatalog(result.taxonomy || null);
      }
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
    if (!encoded || phase || mappingIssue) return;
    const version = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    setPhase('preview');
    setPreview(null);
    setTrusted(false);
    setRetention(false);
    setDecisions([]);
    try {
      const result = await request<DataPackagePreview>('/api/packages/preview', {
        method: 'POST',
        body: JSON.stringify({
          dataBase64: encoded,
          dedup: { enabled },
          ...(loadedKind === 'share' ? { taxonomyMapping: mapping } : {}),
        }),
        signal: controller.signal,
      });
      if (version === generation.current && !controller.signal.aborted) {
        setPreview(result);
        setLoadedKind(result.kind);
        setCatalog(result.taxonomy || null);
        setOptionsChanged(false);
      }
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
      mappingIssue ||
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
          dedup: { enabled },
          ...(preview.kind === 'share' ? { taxonomyMapping: mapping } : {}),
          ...(enabled && preview.dedup ? { decisions } : {}),
          ...(trusted ? { confirmedTrusted: true } : {}),
          ...(retention ? { confirmedRetention: true } : {}),
        }),
      });
      if (version !== generation.current) return;
      setDone(preview.kind);
      setEncoded('');
      setPreview(null);
      setCatalog(null);
      setMapping({});
      setLoadedKind(null);
      setOptionsChanged(false);
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
      {purpose !== 'configuration' && ordinaryImport && !misplaced && (
        <ImportDedupToggle
          enabled={enabled}
          disabled={phase === 'reading' || phase === 'import'}
          onChange={(value) => {
            invalidateOptions();
            setEnabled(value);
          }}
        />
      )}
      {loadedKind === 'share' && catalog && !misplaced && (
        <ImportTaxonomyMappingEditor
          source={catalog}
          local={localTaxonomy}
          value={mapping}
          disabled={phase === 'reading' || phase === 'import'}
          onChange={(value) => {
            invalidateOptions();
            setMapping(value);
          }}
        />
      )}
      {loadedKind === 'migration' && !misplaced && (
        <p className="muted">
          可信迁移保留原ID和学习关系，不执行普通新增的近似合题。需要调整知识归属时，请使用内容分享包。
        </p>
      )}
      {mappingIssue && <ErrorNotice message={mappingIssue} />}
      {optionsChanged && (
        <p className="notice info" role="status">
          导入选项已变更，原预览和处理选择已失效。请重新预览数据包后确认。
        </p>
      )}
      {phase && (
        <div className="action-row">
          <p role="status">
            {phase === 'reading'
              ? '正在读取数据包…可重新选择其他文件。'
              : phase === 'preview'
                ? enabled && ordinaryImport
                  ? '正在校验数据包并检查重复与近似题…'
                  : '正在校验数据包与引用…'
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
            <a className="button" href="#/settings?tab=backup&sub=migration">
              前往 SQLite 迁移
            </a>
          )}
        </>
      )}
      {encoded && !preview && !phase && (
        <button className="button" disabled={!!mappingIssue} onClick={() => void inspectAgain()}>
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
              ? '这是旧版系统配置包。系统迁移现使用 SQLite 数据库或迁移包，请在来源系统重新导出后前往迁移页恢复。'
              : '这是内容或备份包。请在分享与导入中预览并合并；系统迁移使用 SQLite 数据库或迁移包。'}
          </p>
          <a
            className="button"
            href={
              preview?.kind === 'configuration'
                ? '#/settings?tab=backup&sub=migration'
                : '#/sharing?tab=package'
            }
          >
            {preview?.kind === 'configuration' ? '前往 SQLite 迁移' : '前往分享与导入'}
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
          {enabled && preview.dedup && (
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
                setCatalog(null);
                setMapping({});
                setLoadedKind(null);
                setOptionsChanged(false);
              }}
            >
              取消
            </button>
            <button
              className="button primary"
              disabled={
                !!phase ||
                !!mappingIssue ||
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
