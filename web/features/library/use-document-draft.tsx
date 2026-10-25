import { useEffect, useRef, useState } from 'react';
import type { DocumentDraft, DocumentDraftState } from '../../../shared/models/document-drafts';
import type { DocumentRecord } from '../../../shared/models/types';
import { ApiError, idPath, localDate, request, send } from '../../shared/lib/api';
import { ErrorNotice, Loading, Modal } from '../../shared/ui/components';
import './document-drafts.css';

interface Options {
  documentId?: string;
  sourceUpdatedAt?: string;
  state: DocumentDraftState;
  restore(value: DocumentDraftState): void;
  ready: boolean;
  delay: number;
  maximum: number;
}

/** Serial, versioned saves keep the form independent of the published record. */
export function useDocumentDraft({ documentId, sourceUpdatedAt, state, restore, ready, delay, maximum }: Options) {
  const [initialized, setInitialized] = useState(false), [choices, setChoices] = useState<DocumentDraft[] | null>(null);
  const [saving, setSaving] = useState(false), [publishing, setPublishing] = useState(false), [leaving, setLeaving] = useState(false);
  const [error, setError] = useState(''), [savedAt, setSavedAt] = useState(''), [sourceConflict, setSourceConflict] = useState(false);
  const [draftConflict, setDraftConflict] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const snapshot = useRef(state), restoreRef = useRef(restore), selected = useRef<DocumentDraft | null>(null);
  const original = useRef(''), saved = useRef(''), sourceStamp = useRef<string | null>(sourceUpdatedAt || null);
  const active = useRef(true), enabled = useRef(false), finished = useRef(false), isPublishing = useRef(false), isLeaving = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve()), knownHash = useRef(window.location.hash), navigationEpoch = useRef(0);
  const saveOperation = useRef<Promise<DocumentDraft | null> | null>(null);
  const conflict = useRef(false), draftContext = useRef<string | null>(documentId || null);
  const recovered = useRef(false);
  snapshot.current = state; restoreRef.current = restore;
  const serial = JSON.stringify(state);
  const enqueue = <T,>(run: () => Promise<T>): Promise<T> => {
    const operation = queue.current.catch(() => undefined).then(run);
    queue.current = operation; return operation;
  };
  const setFailure = (reason: unknown) => { if (active.current) setError((reason as Error).message); };
  const changed = () => enabled.current && !finished.current && JSON.stringify(snapshot.current) !== original.current;
  const unflushed = () => enabled.current && !finished.current && JSON.stringify(snapshot.current) !== saved.current;

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    enabled.current = false; original.current = JSON.stringify(snapshot.current); saved.current = original.current;
    sourceStamp.current = sourceUpdatedAt || null;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      try {
        const items = await request<DocumentDraft[]>(`/api/document-drafts${documentId ? `?documentId=${idPath(documentId)}` : ''}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setError('');
        if (items.length) setChoices(items);
        else { enabled.current = true; setInitialized(true); }
      } catch (reason) { if (!controller.signal.aborted) setFailure(reason); }
    });
    return () => controller.abort();
  }, [documentId, sourceUpdatedAt, ready, checkRevision]);

  const writeCurrent = async (force = false): Promise<DocumentDraft | null> => {
    if (!enabled.current || finished.current) return null;
    const current = structuredClone(snapshot.current), key = JSON.stringify(current), previous = selected.current;
    if (previous && key === saved.current) return previous;
    if (!previous && !force && key === original.current) return null;
    if (active.current) { setSaving(true); setError(''); }
    try {
      const result = await send<DocumentDraft>(previous ? `/api/document-drafts/${idPath(previous.id)}` : '/api/document-drafts', previous ? 'PUT' : 'POST', previous
        ? { expectedUpdatedAt: previous.updatedAt, state: current }
        : { documentId: draftContext.current, baseDocumentUpdatedAt: draftContext.current ? sourceStamp.current : null, state: current });
      selected.current = result; saved.current = key;
      if (active.current) setSavedAt(result.updatedAt);
      return result;
    } catch (reason) {
      if (previous && reason instanceof ApiError && (reason.code === 'DOCUMENT_DRAFT_VERSION_CONFLICT' || reason.status === 404)) { conflict.current = true; if (active.current) setDraftConflict(true); }
      setFailure(reason); throw reason;
    }
    finally { if (active.current) setSaving(false); }
  };
  const writeRef = useRef(writeCurrent); writeRef.current = writeCurrent;
  const saveNow = () => {
    if (conflict.current) return Promise.reject(new Error('草稿版本已变化，请另存为新草稿后再继续。'));
    if (saveOperation.current) return saveOperation.current;
    // One write in flight plus the newest state; never enqueue a copy of
    // every intermediate large Markdown body while native storage is busy.
    const operation = enqueue(async () => {
      let result: DocumentDraft | null;
      do { result = await writeRef.current(); }
      while (unflushed() && enabled.current && !finished.current);
      return result;
    });
    saveOperation.current = operation;
    void operation.finally(() => { if (saveOperation.current === operation) saveOperation.current = null; }).catch(() => undefined);
    return operation;
  };
  const saveRef = useRef(saveNow); saveRef.current = saveNow;
  useEffect(() => {
    if (!initialized || publishing || leaving || draftConflict) return;
    const timer = window.setTimeout(() => { void saveRef.current().catch(() => undefined); }, delay);
    return () => window.clearTimeout(timer);
  }, [serial, initialized, publishing, leaving, draftConflict, delay]);

  const saveAsNewDraft = async () => {
    if (!window.confirm('把当前页面内容另存为一份新草稿？其他页面保存的草稿保持不变。')) return;
    return enqueue(async () => {
      selected.current = null;
      const result = await writeRef.current(true);
      conflict.current = false; if (active.current) setDraftConflict(false);
      return result;
    });
  };

  const publish = (asNew = false): Promise<DocumentRecord> => {
    if (!enabled.current || isPublishing.current) return Promise.reject(new Error('请先完成草稿检查，再保存资料。'));
    if (conflict.current && !asNew) return Promise.reject(new Error('草稿版本已变化，请另存为新草稿或新资料。'));
    isPublishing.current = true; setPublishing(true); setError('');
    return enqueue(async () => {
      try {
        if (asNew && conflict.current) { selected.current = null; draftContext.current = null; }
        const draft = await writeRef.current(true);
        if (!draft) throw new Error('资料草稿尚未准备完成，请稍后重试。');
        const document = await send<DocumentRecord>(`/api/document-drafts/${idPath(draft.id)}/publish`, 'POST', { expectedUpdatedAt: draft.updatedAt, ...(asNew ? { asNew: true } : {}) });
        finished.current = true; enabled.current = false; selected.current = null;
        return document;
      } catch (reason) {
        if (reason instanceof ApiError && ['DOCUMENT_VERSION_CONFLICT', 'DOCUMENT_DRAFT_SOURCE_CHANGED', 'DOCUMENT_DRAFT_SOURCE_UNAVAILABLE', 'DOCUMENT_ARCHIVED', 'NOT_FOUND'].includes(reason.code)) setSourceConflict(true);
        setFailure(reason); throw reason;
      } finally { isPublishing.current = false; if (active.current) setPublishing(false); }
    });
  };

  useEffect(() => {
    active.current = true;
    const leave = async (destination: () => void) => {
      if (isLeaving.current || isPublishing.current) return;
      if (!changed()) { destination(); return; }
      if (!window.confirm('这份资料尚未正式保存。保存当前草稿后离开？下次进入可继续编辑。')) return;
      isLeaving.current = true; if (active.current) setLeaving(true);
      try {
        await saveRef.current();
        if (unflushed()) throw new Error('还有内容未保存到草稿，请稍后重试。');
        finished.current = true;
        destination();
      } catch (reason) { setFailure(reason); }
      finally { isLeaving.current = false; if (active.current) setLeaving(false); }
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.href === window.location.href) return;
      if (!changed() && !isPublishing.current && !isLeaving.current) return;
      event.preventDefault(); event.stopPropagation();
      void leave(() => { window.location.assign(target.href); });
    };
    const hash = (event: HashChangeEvent) => {
      const previous = knownHash.current, next = window.location.hash;
      if (previous === next) return;
      if (!changed() && !isPublishing.current && !isLeaving.current) { knownHash.current = next; return; }
      event.stopImmediatePropagation();
      const epoch = ++navigationEpoch.current;
      window.history.replaceState(null, '', previous || '#/');
      void leave(() => {
        if (epoch !== navigationEpoch.current) return;
        knownHash.current = next; finished.current = true;
        window.history.replaceState(null, '', next || '#/');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (changed() || isPublishing.current || isLeaving.current) { event.preventDefault(); event.returnValue = ''; }
      if (unflushed() && !isPublishing.current) void saveRef.current().catch(() => undefined);
    };
    const hidden = () => { if (document.visibilityState === 'hidden' && unflushed() && !isPublishing.current) void saveRef.current().catch(() => undefined); };
    const pagehide = () => { if (unflushed() && !isPublishing.current) void saveRef.current().catch(() => undefined); };
    document.addEventListener('click', click, true); window.addEventListener('hashchange', hash, true); window.addEventListener('beforeunload', unload);
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', pagehide);
    return () => {
      active.current = false;
      document.removeEventListener('click', click, true); window.removeEventListener('hashchange', hash, true); window.removeEventListener('beforeunload', unload);
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', pagehide);
    };
  }, []);

  const choose = (draft?: DocumentDraft) => {
    if (saving) return;
    selected.current = draft || null;
    conflict.current = false; setDraftConflict(false);
    if (draft) {
      recovered.current = true;
      sourceStamp.current = draft.baseDocumentUpdatedAt; saved.current = JSON.stringify(draft.state);
      snapshot.current = structuredClone(draft.state); restoreRef.current(structuredClone(draft.state));
      setSavedAt(draft.updatedAt); setSourceConflict(!!documentId && draft.baseDocumentUpdatedAt !== (sourceUpdatedAt || null));
    } else { saved.current = original.current; setSavedAt(''); setSourceConflict(false); }
    setChoices(null); setError(''); enabled.current = true; setInitialized(true);
  };
  const remove = async (draft: DocumentDraft) => {
    if (!window.confirm(`删除资料草稿「${draft.state.title || '未命名资料'}」？此操作不会删除正式资料。`)) return;
    setSaving(true); setError('');
    try { await send(`/api/document-drafts/${idPath(draft.id)}`, 'DELETE', { expectedUpdatedAt: draft.updatedAt }); setChoices(values => values?.filter(item => item.id !== draft.id) || []); }
    catch (reason) { setFailure(reason); }
    finally { setSaving(false); }
  };
  const pending = initialized && serial !== saved.current;
  const picker = choices !== null && <Modal title="继续资料草稿" onClose={() => { if (!saving) choose(); }}>
    <p>发现 {choices.length} 份资料草稿，按最近保存排序。继续编辑会更新同一份草稿；每个资料编辑入口最多保留 {maximum} 份。</p>
    {error && <ErrorNotice message={error} />}
    <div className="document-draft-choices">{choices.map(draft => <div className="document-draft-choice" key={draft.id}>
      <div><strong>{draft.state.title || '未命名资料'}</strong><p>{draft.state.format === 'pdf' ? 'PDF附件' : 'Markdown正文'} · {localDate(draft.updatedAt)}</p><p className="document-draft-excerpt">{draft.state.format === 'pdf' ? draft.state.fileName : draft.state.bodyMarkdown.slice(0, 100) || '正文尚未填写'}</p>{documentId && draft.baseDocumentUpdatedAt !== (sourceUpdatedAt || null) && <p className="document-draft-warning">原资料已有更新，恢复后可另存为新资料，避免覆盖较新内容。</p>}</div>
      <div className="action-row"><button type="button" className="button primary" disabled={saving} onClick={() => choose(draft)}>继续此草稿</button><button type="button" className="button danger-text" disabled={saving} onClick={() => void remove(draft)}>删除此草稿</button></div>
    </div>)}</div>
    <div className="form-actions"><button type="button" className="button" disabled={saving} onClick={() => choose()}>{documentId ? '重新编辑' : '新建资料'}</button></div>
  </Modal>;
  const status = <div className="document-draft-status" role="status" aria-label="资料草稿状态">
    {error ? <ErrorNotice message={`资料草稿操作失败：${error}`} retry={() => { if (initialized) void saveNow().catch(() => undefined); else setCheckRevision(value => value + 1); }} />
      : !initialized && choices === null ? <Loading text="正在检查资料草稿…" />
      : publishing ? '正在保存正式资料…' : leaving ? '正在保存草稿并准备离开…' : saving ? '正在保存资料草稿…' : pending ? '资料有更改，等待自动保存草稿…'
      : savedAt ? `资料草稿已保存 ${localDate(savedAt)}；尚未正式保存。` : `编辑内容自动保存为资料草稿，最多保留 ${maximum} 份。`}
  </div>;
  return { initialized, saving, publishing, leaving, sourceConflict, draftConflict, hasDraft: !!selected.current || recovered.current, picker, status, saveNow, saveAsNewDraft, publish };
}
