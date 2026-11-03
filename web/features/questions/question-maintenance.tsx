import { useEffect, useRef, useState } from 'react';
import { FileClock, History, Save, Trash2 } from 'lucide-react';
import type { Question, QuestionInput } from '../../../shared/models/types';
import type {
  QuestionDraftDetail,
  QuestionDraftSummary,
  QuestionMaintenancePage,
  QuestionRevisionDetail,
} from '../../../shared/models/question-maintenance';
import { idPath, localDate, qs, request, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, Pagination, useApp } from '../../shared/ui/components';
import { questionEditorSources, questionEditorValue } from './question-editor-state';
import {
  questionContentDifferences,
  questionDraftForm,
  questionDraftSignature,
  questionRevisionFieldLabel,
  questionRevisionFieldText,
  questionRevisionForm,
} from './question-maintenance-state';
import { QuestionRevisionHistory } from './question-revision-history';
import './question-maintenance.css';

interface Props {
  questionId?: string;
  source: Question | null;
  form: QuestionInput;
  sources: string;
  dirty: boolean;
  disabled: boolean;
  onLoad: (form: QuestionInput, sources: string) => void;
  beforeRestore: () => Promise<boolean>;
  onRestored: (question: Question) => void;
  onRefreshSource: (question: Question) => void;
}

/** Explicit persistent drafts are independent from admission state and source
 * saves. Every writer owns a lock; responses never overwrite a later editor. */
export function useQuestionMaintenance(props: Props) {
  const { bootstrap, toast } = useApp();
  const latest = useRef(props);
  latest.current = props;
  const initial = useRef<{ form: QuestionInput; sources: string } | null>(null);
  if (!initial.current)
    initial.current = { form: structuredClone(props.form), sources: props.sources };
  const mounted = useRef(true),
    locked = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [reason, setReason] = useState(''),
    [active, setActive] = useState<QuestionDraftDetail | null>(null);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | null | undefined>(undefined),
    [savedDraftSignature, setSavedDraftSignature] = useState('');
  const [draftsOpen, setDraftsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false),
    [conflictOpen, setConflictOpen] = useState(false);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(5),
    [historyRefresh, setHistoryRefresh] = useState(0);
  const draftUrl = `/api/question-drafts?${qs({ questionId: props.questionId, page, pageSize })}`;
  const drafts = useResource<QuestionMaintenancePage<QuestionDraftSummary>>(draftUrl);
  const version = props.source?.updatedAt || null;
  const conflict = baseUpdatedAt !== undefined && !!props.questionId && baseUpdatedAt !== version;
  const currentSignature = questionDraftSignature(props.form, props.sources, reason);
  const coveredByDraft = !!active && currentSignature === savedDraftSignature;
  const pending = (props.dirty || !!reason.trim()) && !coveredByDraft;
  const disabled = props.disabled || busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const activeNow = () => mounted.current;

  async function run(operation: () => Promise<void>) {
    if (locked.current || latest.current.disabled) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      await sourceSaveFailed(failure);
      if (activeNow()) {
        const message = (failure as Error).message;
        setError(message);
        toast(message, true);
      }
    } finally {
      locked.current = false;
      if (activeNow()) setBusy(false);
    }
  }

  async function saveDraft(asNew = false) {
    await run(async () => {
      const captured = latest.current;
      const state = { form: questionDraftForm(captured.form), sources: captured.sources, reason };
      const base = baseUpdatedAt === undefined ? captured.source?.updatedAt || null : baseUpdatedAt;
      const result = await send<QuestionDraftDetail>(
        active && !asNew ? `/api/question-drafts/${idPath(active.id)}` : '/api/question-drafts',
        active && !asNew ? 'PUT' : 'POST',
        active && !asNew
          ? {
              expectedUpdatedAt: active.updatedAt,
              state,
              ...(base !== active.baseUpdatedAt ? { baseUpdatedAt: base } : {}),
            }
          : { questionId: captured.questionId || null, baseUpdatedAt: base, state },
      );
      if (!activeNow()) return;
      setActive(result);
      setBaseUpdatedAt(result.baseUpdatedAt);
      setSavedDraftSignature(questionDraftSignature(captured.form, captured.sources, reason));
      drafts.refresh();
      toast(asNew ? '已另存一份编辑草稿' : '编辑草稿已保存，可稍后继续');
    });
  }

  async function loadDraft(id: string) {
    if (
      (latest.current.dirty || reason.trim()) &&
      !coveredByDraft &&
      !confirm('当前编辑尚未保存。载入草稿将替换当前表单；取消后可先保存一份草稿。继续载入？')
    )
      return;
    const before = currentSignature;
    await run(async () => {
      const [draft, current] = await Promise.all([
        request<QuestionDraftDetail>(`/api/question-drafts/${idPath(id)}`),
        latest.current.questionId
          ? request<Question>(`/api/questions/${idPath(latest.current.questionId)}`)
          : Promise.resolve(null),
      ]);
      if (!activeNow()) return;
      if (before !== questionDraftSignature(latest.current.form, latest.current.sources, reason))
        throw Error('读取草稿期间编辑内容已变化，请保留当前内容并重新选择草稿。');
      const value = {
        ...structuredClone(draft.state.form),
        ...(latest.current.questionId ? { id: latest.current.questionId } : {}),
      };
      if (current) latest.current.onRefreshSource(current);
      setActive(draft);
      setBaseUpdatedAt(draft.baseUpdatedAt);
      setReason(draft.state.reason);
      setSavedDraftSignature(
        questionDraftSignature(value, draft.state.sources, draft.state.reason),
      );
      const changed = !!current && draft.baseUpdatedAt !== current.updatedAt;
      setConflictOpen(changed);
      latest.current.onLoad(value, draft.state.sources);
      toast(
        changed
          ? '草稿已载入，请先对照当前原题并确认编辑基础'
          : '已继续此编辑草稿，再保存会覆盖本份草稿',
      );
    });
  }

  async function removeDraft(draft: QuestionDraftSummary) {
    if (!confirm('删除这份编辑草稿？已经正式保存的原题不受影响。')) return;
    await run(async () => {
      await send(`/api/question-drafts/${idPath(draft.id)}`, 'DELETE', {
        expectedUpdatedAt: draft.updatedAt,
      });
      if (!activeNow()) return;
      if (active?.id === draft.id) {
        setActive(null);
        setSavedDraftSignature('');
      }
      drafts.refresh();
      toast('编辑草稿已删除，当前表单内容仍保留');
    });
  }

  function currentSource() {
    if (pending && !confirm('放弃当前未保存编辑，重新使用已保存原题？取消后可以先保存草稿。'))
      return;
    if (disabled) return;
    const value = latest.current.source
      ? questionEditorValue(latest.current.source)
      : structuredClone(initial.current!.form);
    latest.current.onLoad(
      value,
      latest.current.source ? questionEditorSources(value.sourceRefs) : initial.current!.sources,
    );
    setActive(null);
    setBaseUpdatedAt(undefined);
    setSavedDraftSignature('');
    setReason('');
    setConflictOpen(false);
  }

  function loadRevision(revision: QuestionRevisionDetail) {
    if (
      disabled ||
      (pending && !confirm('载入修订会替换当前未保存编辑。取消后可先保存草稿。继续？'))
    )
      return;
    const value = questionRevisionForm(revision.content, latest.current.form);
    latest.current.onLoad(value, questionEditorSources(value.sourceRefs));
    setReason(`基于修订 #${revision.sequence} 调整`);
    setSavedDraftSignature('');
    setHistoryOpen(false);
    toast('历史内容已载入编辑器，核对后保存才会更新原题');
  }

  async function restoreRevision(revision: QuestionRevisionDetail) {
    if (
      !confirm(
        `将修订 #${revision.sequence} 恢复并保存为新修订？${pending ? '当前未保存表单将被替换，可取消后先保存草稿。' : ''}已保存的编辑草稿仍保留。`,
      )
    )
      return;
    await run(async () => {
      if (!(await latest.current.beforeRestore())) return;
      if (!activeNow()) return;
      const question = await send<Question>(
        `/api/questions/${idPath(latest.current.questionId!)}/revisions/${idPath(revision.id)}/restore`,
        'POST',
        {
          expectedUpdatedAt: latest.current.source?.updatedAt,
          confirmed: true,
          reason: reason.trim() || `恢复至修订 #${revision.sequence}`,
        },
      );
      if (!activeNow()) return;
      setActive(null);
      setBaseUpdatedAt(undefined);
      setReason('');
      setSavedDraftSignature('');
      setHistoryRefresh((value) => value + 1);
      drafts.refresh();
      latest.current.onRestored(question);
      toast('已恢复并保存为新修订');
    });
  }

  function saveMetadata() {
    if (locked.current) throw Error('编辑草稿或修订正在处理，请稍后保存原题。');
    if (conflict)
      throw Error('当前编辑基于较早版本，请先对照当前原题并明确确认编辑基础，再保存原题。');
    return {
      revisionReason: reason.trim(),
      ...(props.questionId
        ? { updatedAt: baseUpdatedAt === undefined ? version : baseUpdatedAt }
        : {}),
      ...(active ? { draftId: active.id, draftUpdatedAt: active.updatedAt } : {}),
    };
  }
  function sourceSaved() {
    setActive(null);
    setBaseUpdatedAt(undefined);
    setReason('');
    setSavedDraftSignature('');
    setConflictOpen(false);
    setHistoryRefresh((value) => value + 1);
    drafts.refresh();
  }
  async function sourceSaveFailed(failure: unknown) {
    // Called by the already-locked source writer. Refresh only the saved
    // baseline; the current text and its old editing version stay protected.
    if (!props.questionId || (failure as { code?: string })?.code !== 'QUESTION_VERSION_CONFLICT')
      return;
    const previous = baseUpdatedAt === undefined ? version : baseUpdatedAt;
    try {
      const current = await request<Question>(`/api/questions/${idPath(props.questionId)}`);
      if (!activeNow()) return;
      setBaseUpdatedAt(previous);
      setConflictOpen(true);
      latest.current.onRefreshSource(current);
    } catch {
      /* Original save error remains visible; local content is retained. */
    }
  }

  const differences =
    conflictOpen && props.source
      ? questionContentDifferences(
          questionDraftForm(props.form),
          questionDraftForm(questionEditorValue(props.source)),
        )
      : [];
  const draftLimit = bootstrap.settings?.maxQuestionDrafts ?? 3;
  const panel = (
    <section className="question-maintenance card form-stack" aria-label="题目内容维护">
      <div className="question-maintenance-heading">
        <div className="question-maintenance-actions">
          <button
            type="button"
            className="button"
            disabled={disabled}
            aria-expanded={draftsOpen}
            onClick={() => setDraftsOpen(!draftsOpen)}
          >
            <FileClock size={16} />
            编辑草稿{drafts.data?.total ? `（${drafts.data.total}）` : ''}
          </button>
          {props.questionId && (
            <button
              type="button"
              className="button"
              disabled={disabled}
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(!historyOpen)}
            >
              <History size={16} />
              修订历史
            </button>
          )}
        </div>
        <span className="muted">编辑草稿需点击保存，每题最多保留最近{draftLimit}份。</span>
      </div>
      {error && <ErrorNotice message={error} />}
      {active && (
        <div className={`notice ${conflict ? 'error' : 'info'} question-draft-state`}>
          <div>
            <strong>{conflict ? '原题已在草稿保存后更新' : '正在继续编辑草稿'}</strong>
            <p>
              {coveredByDraft
                ? '当前编辑已保存为草稿，可安全离开；尚未更新正式原题。'
                : '当前还有未存入草稿的编辑。'}{' '}
              保存草稿将覆盖本份，另存可创建新份。
            </p>
          </div>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => void saveDraft(true)}
          >
            另存一份草稿
          </button>
        </div>
      )}
      {!active && !!drafts.data?.total && !draftsOpen && (
        <div className="question-draft-offer">
          <span>有{drafts.data.total}份编辑草稿，可选择继续。</span>
          <button type="button" className="text-button" onClick={() => setDraftsOpen(true)}>
            查看草稿
          </button>
        </div>
      )}
      {conflict && (
        <div className="question-draft-conflict form-stack" aria-label="草稿版本冲突">
          <p>
            当前编辑内容已保留。保存原题前，请对照当前已保存内容；也可以继续保存草稿或重新使用当前原题。
          </p>
          <div className="question-maintenance-actions">
            <button
              className="button"
              type="button"
              disabled={disabled}
              onClick={() => setConflictOpen(!conflictOpen)}
            >
              {conflictOpen ? '收起版本对照' : '对照当前原题'}
            </button>
            <button className="button" type="button" disabled={disabled} onClick={currentSource}>
              重新使用当前原题
            </button>
          </div>
          {conflictOpen && (
            <>
              <div className="question-conflict-fields">
                {differences.map((item) => (
                  <details key={item.field}>
                    <summary>{questionRevisionFieldLabel(item.field)}</summary>
                    <div className="question-revision-diff">
                      <div>
                        <span>当前编辑草稿</span>
                        <pre>
                          {questionRevisionFieldText(item.field, item.before).slice(0, 12000)}
                        </pre>
                      </div>
                      <div>
                        <span>当前已保存原题</span>
                        <pre>
                          {questionRevisionFieldText(item.field, item.after).slice(0, 12000)}
                        </pre>
                      </div>
                    </div>
                  </details>
                ))}
                <details>
                  <summary>参考来源原始编辑文本</summary>
                  <pre>{props.sources || '空'}</pre>
                </details>
              </div>
              <button
                type="button"
                className="button"
                disabled={disabled}
                onClick={() => {
                  if (
                    confirm(
                      '已核对版本差异，确认以当前原题版本为基础继续编辑？现有表单内容将保留。',
                    )
                  ) {
                    setBaseUpdatedAt(version);
                    setSavedDraftSignature('');
                    setError('');
                  }
                }}
              >
                已核对，以当前原题为基础
              </button>
            </>
          )}
        </div>
      )}
      {draftsOpen && (
        <div className="question-drafts-manager form-stack" aria-label="题目编辑草稿列表">
          <div className="question-maintenance-heading">
            <h2>编辑草稿</h2>
            {active && (
              <button type="button" className="button" disabled={disabled} onClick={currentSource}>
                {props.questionId ? '从当前原题继续' : '重新开始编辑'}
              </button>
            )}
          </div>
          {drafts.loading || (drafts.dataUrl !== draftUrl && !drafts.error) ? (
            <Loading text="正在读取编辑草稿…" />
          ) : drafts.error ? (
            <ErrorNotice message={drafts.error} retry={drafts.refresh} />
          ) : !drafts.data?.total ? (
            <p className="muted">暂无编辑草稿。未填完整的题目也可以保存草稿。</p>
          ) : (
            <>
              <div className="question-maintenance-list">
                {drafts.data.items.map((draft) => (
                  <article className="question-maintenance-item" key={draft.id}>
                    <div>
                      <strong>{draft.title || '未命名题目'}</strong>
                      <small>
                        {localDate(draft.updatedAt)}
                        {draft.conflict ? ' · 原题已更新' : ''}
                        {active?.id === draft.id ? ' · 正在编辑' : ''}
                      </small>
                    </div>
                    <div className="question-maintenance-actions">
                      <button
                        className="button"
                        type="button"
                        disabled={disabled}
                        onClick={() => void loadDraft(draft.id)}
                      >
                        继续此草稿
                      </button>
                      <button
                        className="button danger"
                        type="button"
                        aria-label={`删除编辑草稿 ${draft.id}`}
                        disabled={disabled}
                        onClick={() => void removeDraft(draft)}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <Pagination
                page={page}
                pageSize={pageSize}
                total={drafts.data.total}
                onPage={setPage}
                onPageSize={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                label="编辑草稿"
              />
            </>
          )}
        </div>
      )}
      <details className="question-revision-reason">
        <summary>修改原因（可选）{reason.trim() ? ' · 已填写' : ''}</summary>
        <Field label="本次修改原因" hint="与编辑草稿或本次修订一起保存，用于之后核对变更。">
          <input
            value={reason}
            maxLength={1000}
            disabled={disabled}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：修正参考答案，补全判题条件"
          />
        </Field>
      </details>
      {historyOpen && props.questionId && (
        <QuestionRevisionHistory
          key={props.questionId + ':' + historyRefresh}
          questionId={props.questionId}
          refreshKey={historyRefresh}
          disabled={disabled}
          onLoad={loadRevision}
          onRestore={(revision) => void restoreRevision(revision)}
        />
      )}
    </section>
  );
  const draftButton = (
    <button type="button" className="button" disabled={disabled} onClick={() => void saveDraft()}>
      <Save size={16} />
      保存编辑草稿
    </button>
  );
  return {
    panel,
    draftButton,
    busy,
    isBusy: () => locked.current,
    pending,
    coveredByDraft,
    saveMetadata,
    sourceSaved,
    sourceSaveFailed,
  };
}
