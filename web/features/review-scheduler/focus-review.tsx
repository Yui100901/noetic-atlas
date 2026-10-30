import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Clock3, Pause, SkipForward } from 'lucide-react';
import type { FocusView } from '../../../shared/models/focus-review';
import type { ReviewRating } from '../../../shared/models/adaptive-review';
import { REVIEW_RATING_LABELS } from '../../../shared/models/adaptive-review';
import { idPath, localDate, send, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Field, Loading, PageHeader, useApp } from '../../shared/ui/components';
import { QuestionContent } from '../../shared/ui/content-notices';
import { QuestionStructuredBody } from '../questions/question-structure';
import { usePracticeTimer } from '../practice/use-practice-timer';
import { useSaveBeforeNavigation } from '../../shared/lib/save-before-navigation';
import { isSubjectiveType } from '../../../shared/questions/question-utils';
import './focus-review.css';

const signature = (mode: string, value: string | string[]) => JSON.stringify({ mode, value });
const emptyValue = (type: string) => (['fill_blank', 'multiple_choice'].includes(type) ? [] : '');
export function FocusReviewPage({ id }: { id: string }) {
  const path = `/api/focus-sessions/${idPath(id)}`,
    resource = useResource<FocusView>(path),
    { reload } = useApp();
  const view = resource.data,
    current = view?.current;
  const timer = usePracticeTimer(id, view, view?.status === 'in_progress', '/api/focus-sessions');
  const [mode, setMode] = useState<'mental' | 'written'>('mental'),
    [value, setValue] = useState<string | string[]>(''),
    [verdict, setVerdict] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const latest = useRef(view);
  latest.current = view;
  const local = useRef({ mode, value });
  local.current = { mode, value };
  const baseline = useRef(''),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    saving = useRef(false);
  const acting = useRef(false);
  const accept = (next: FocusView) => {
    latest.current = next;
    resource.setData(next);
  };
  useEffect(() => {
    const item = latest.current?.current;
    if (!item) return;
    const mode =
      item.answer || item.phase !== 'recall'
        ? item.mode
        : isSubjectiveType(item.question.type)
          ? 'mental'
          : 'written';
    const value = item.answer?.value ?? emptyValue(item.question.type);
    setMode(mode);
    setValue(value);
    setVerdict('');
    baseline.current = signature(mode, value);
    setError('');
  }, [current?.key]);
  const serialize = <T,>(run: () => Promise<T>) => {
    const next = queue.current.then(run);
    queue.current = next.catch(() => undefined);
    return next;
  };
  const dirty = () =>
    latest.current?.current?.phase === 'recall' &&
    signature(local.current.mode, local.current.value) !== baseline.current;
  const saveDraft = async () => {
    const key = latest.current?.current?.key,
      captured = { ...local.current };
    if (!dirty()) return true;
    return serialize(async () => {
      const session = latest.current,
        item = session?.current;
      if (!session || !item || item.key !== key || item.phase !== 'recall') return true;
      saving.current = true;
      try {
        const next = await send<FocusView>(path + '/current', 'PUT', {
          index: item.index,
          revision: session.revision,
          action: 'save',
          mode: captured.mode,
          answer: captured.value,
        });
        accept(next);
        baseline.current = signature(captured.mode, captured.value);
        setError('');
        return true;
      } catch (reason) {
        setError((reason as Error).message);
        return false;
      } finally {
        saving.current = false;
      }
    });
  };
  useEffect(() => {
    if (busy || !dirty()) return;
    const handle = setTimeout(() => {
      void saveDraft();
    }, 600);
    return () => clearTimeout(handle);
  }, [mode, value, current?.key, busy]);
  const leave = async () => {
    await queue.current;
    if (!(await saveDraft())) return false;
    try {
      await timer.pause();
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    }
  };
  useSaveBeforeNavigation({ pending: () => dirty() || saving.current || busy, save: leave });
  const back = view?.paperId ? `#/papers/${idPath(view.paperId)}?tab=review` : '#/learning/due';
  const act = async (action: 'reveal' | 'rate' | 'skip', rating?: ReviewRating) => {
    if (acting.current || busy || !latest.current?.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!(await saveDraft())) return;
      await timer.checkpoint();
      await serialize(async () => {
        const session = latest.current!,
          item = session.current!;
        const next = await send<FocusView>(path + '/current', 'PUT', {
          index: item.index,
          revision: session.revision,
          action,
          ...(action === 'reveal' ? { mode: local.current.mode, answer: local.current.value } : {}),
          ...(rating ? { rating, verdict: verdict || null } : {}),
        });
        accept(next);
        baseline.current = signature(local.current.mode, local.current.value);
        reload();
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };
  const end = async () => {
    if (
      !view ||
      acting.current ||
      busy ||
      !confirm('结束本次复习并查看总结？未完成任务仍保留原复习安排。')
    )
      return;
    acting.current = true;
    setBusy(true);
    try {
      if (!(await leave())) return;
      const next = await send<FocusView>(path + '/finish', 'POST', {
        revision: latest.current!.revision,
      });
      accept(next);
      reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.closest('input,textarea,select,button,a,summary,[contenteditable="true"]') ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if (event.code === 'Space' && current?.phase === 'recall') {
        event.preventDefault();
        void act('reveal');
      }
      if (current?.phase === 'revealed' && ['1', '2', '3', '4'].includes(event.key)) {
        const rating = (['again', 'hard', 'good', 'easy'] as const)[Number(event.key) - 1];
        if ((current.correct === false || (verdict && verdict !== 'correct')) && rating !== 'again')
          return;
        event.preventDefault();
        void act('rate', rating);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [current?.key, current?.phase, mode, value, busy, verdict]);
  if (resource.loading) return <Loading text="正在读取专注复习…" />;
  if (resource.error || !view)
    return <ErrorNotice message={resource.error || '复习会话不存在'} retry={resource.refresh} />;
  const elapsed = Math.max(timer.elapsedSeconds, view.elapsedSeconds),
    clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  if (view.status === 'submitted')
    return (
      <article className="focus-page">
        <a className="back-link" href={back}>
          <ArrowLeft size={15} />
          返回{view.paperId ? '题集复习' : '待复习'}
        </a>
        <PageHeader eyebrow="专注复习总结" title="本次复习已结束" description={view.title} />
        {view.reset && <p className="notice info">学习进度已重置，本会话仅作为历史保留。</p>}
        <section className="card focus-summary">
          <h2>本次进度</h2>
          <dl>
            <div>
              <dt>完成评级</dt>
              <dd>
                {view.rated} / {view.total}
              </dd>
            </div>
            <div>
              <dt>实际作答</dt>
              <dd>{view.written}</dd>
            </div>
            <div>
              <dt>心答自评</dt>
              <dd>{view.mental}</dd>
            </div>
            <div>
              <dt>本次用时</dt>
              <dd>{clock}</dd>
            </div>
            <div>
              <dt>跳过 / 未完成</dt>
              <dd>
                {view.skipped} / {view.total - view.rated - view.skipped}
              </dd>
            </div>
          </dl>
          <p className="muted">实际提交的回答计入单题统计；心答自评记录复习与回忆评级。</p>
          <div className="focus-summary-ratings">
            {Object.entries(REVIEW_RATING_LABELS).map(([rating, label]) => (
              <span key={rating}>
                {label} <strong>{view.ratings[rating as ReviewRating]}</strong>
              </span>
            ))}
          </div>
        </section>
        <section className="card focus-results">
          <h2>任务与后续安排</h2>
          {view.results.map((item) => (
            <div key={item.index}>
              <strong>
                {item.index + 1}. {item.title}
              </strong>
              <span>
                {item.rating ? REVIEW_RATING_LABELS[item.rating] : '已跳过'}
                {item.dueAt && ` · 下次 ${localDate(item.dueAt)}`}
              </span>
              {item.attemptId && (
                <a className="button" href={`#/attempts/${idPath(item.attemptId)}`}>
                  查看实际作答
                </a>
              )}
            </div>
          ))}
        </section>
      </article>
    );
  if (!current) return <Empty title="当前没有复习任务" />;
  const question = current.question,
    revealed = current.phase === 'revealed',
    subjective = isSubjectiveType(question.type),
    reference = current.reference;
  const hasAnswer = Array.isArray(value) ? value.some((v) => !!v.trim()) : !!value.trim();
  const options =
    question.type === 'true_false'
      ? [
          { key: 'true', text: '正确' },
          { key: 'false', text: '错误' },
        ]
      : question.options;
  const mustAgain = current.correct === false || (!!verdict && verdict !== 'correct');
  const values = Array.isArray(current.answer?.value)
    ? current.answer.value
    : [current.answer?.value || ''];
  const answerText = subjective
    ? values.join('\n\n')
    : values
        .map((answer, index) =>
          question.type === 'fill_blank'
            ? `${index + 1}. ${answer}`
            : answer === 'true'
              ? '正确'
              : answer === 'false'
                ? '错误'
                : `${answer}. ${question.options.find((option) => option.key === answer)?.text || answer}`,
        )
        .join('\n\n');
  return (
    <article className="focus-page" aria-label="专注复习会话">
      <PageHeader
        eyebrow="专注复习"
        title={view.title}
        description={`${view.rated} 项已评级 · ${view.skipped} 项已跳过 · 当前第 ${current.index + 1} / ${view.total} 项`}
        actions={
          <>
            <span className="focus-clock" aria-label="本次复习用时">
              <Clock3 size={16} />
              {clock}
            </span>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                void leave().then((ok) => {
                  if (ok) window.location.hash = back;
                });
              }}
            >
              <Pause size={15} />
              保存并退出
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => void end()}>
              结束本次复习
            </button>
          </>
        }
      />
      <progress
        className="focus-progress"
        aria-label="本次复习进度"
        max={view.total}
        value={view.rated + view.skipped}
      />
      {(error || timer.error) && <ErrorNotice message={error || timer.error} />}
      <section className="card focus-question">
        <div className="section-label">
          {current.direction === 'meaning_to_word' ? '逆向回忆' : '回忆阶段'}
        </div>
        <h2>{question.title}</h2>
        {question.groupStemMarkdown && (
          <section className="group-material">
            <span className="section-label">共用材料 · {question.groupTitle}</span>
            <QuestionContent>{question.groupStemMarkdown}</QuestionContent>
          </section>
        )}
        <QuestionContent questionType={question.type}>{question.stemMarkdown}</QuestionContent>
        {!revealed && (
          <>
            <div className="segmented focus-answer-mode" role="group" aria-label="回忆方式">
              <button
                type="button"
                disabled={busy}
                className={mode === 'mental' ? 'selected' : ''}
                onClick={() => setMode('mental')}
              >
                心答自评
              </button>
              <button
                type="button"
                disabled={busy}
                className={mode === 'written' ? 'selected' : ''}
                onClick={() => setMode('written')}
              >
                填写回答
              </button>
            </div>
            {mode === 'mental' ? (
              <p className="muted">
                先在心里完整回答，再核对参考答案；本项只记录复习，不计作答正误。
              </p>
            ) : subjective ? (
              <Field label="本次回答">
                <textarea
                  rows={6}
                  disabled={busy}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="用自己的话说明关键结论和依据…"
                />
              </Field>
            ) : question.type === 'fill_blank' ? (
              <div className="focus-blanks">
                {question.blanks?.map((blank, index) => (
                  <Field key={blank.id} label={`${index + 1}. ${blank.label}`}>
                    <input
                      disabled={busy}
                      autoComplete="off"
                      value={Array.isArray(value) ? value[index] || '' : ''}
                      onChange={(event) =>
                        setValue(
                          question.blanks!.map((_, i) =>
                            i === index
                              ? event.target.value
                              : Array.isArray(value)
                                ? value[i] || ''
                                : '',
                          ),
                        )
                      }
                    />
                  </Field>
                ))}
              </div>
            ) : (
              <fieldset className="focus-options" disabled={busy}>
                <legend className="sr-only">本次回答</legend>
                {options.map((option) => {
                  const checked = Array.isArray(value)
                    ? value.includes(option.key)
                    : value === option.key;
                  return (
                    <label key={option.key} className={checked ? 'selected' : ''}>
                      <input
                        type={question.type === 'multiple_choice' ? 'checkbox' : 'radio'}
                        name="focus-answer"
                        checked={checked}
                        onChange={() =>
                          setValue(
                            question.type === 'multiple_choice'
                              ? checked
                                ? (Array.isArray(value) ? value : []).filter(
                                    (v) => v !== option.key,
                                  )
                                : [...(Array.isArray(value) ? value : []), option.key]
                              : option.key,
                          )
                        }
                      />
                      <strong>{question.type === 'true_false' ? '' : option.key}</strong>
                      <QuestionContent>{option.text}</QuestionContent>
                    </label>
                  );
                })}
              </fieldset>
            )}
            <div className="focus-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void act('skip')}
              >
                <SkipForward size={16} />
                跳过本题
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || (mode === 'written' && !hasAnswer)}
                onClick={() => void act('reveal')}
              >
                <BookOpen size={17} />
                {mode === 'written' ? '提交回答并核对' : '我已回忆，核对答案'}
                <kbd>空格</kbd>
              </button>
            </div>
          </>
        )}
        {revealed && reference && (
          <>
            {current.mode === 'written' && (
              <details className="focus-submitted-answer" open>
                <summary>你的回答</summary>
                <QuestionContent>{answerText}</QuestionContent>
              </details>
            )}
            <section className="focus-reference">
              <h3>参考答案与解析</h3>
              {current.mode === 'written' && (
                <div className="notice info">
                  {current.correct === undefined
                    ? '回答已提交，主观题保持未判；可在下方核对判定。'
                    : current.correct
                      ? '本次回答正确，建议选择良好；回忆费力也可选困难。'
                      : '本次回答错误，请选择重学。'}
                </div>
              )}
              <QuestionStructuredBody question={reference} showAnswers />
              {reference.correctAnswers.length > 0 && (
                <p>
                  参考答案：
                  {reference.correctAnswers
                    .map((v) => (v === 'true' ? '正确' : v === 'false' ? '错误' : v))
                    .join('、')}
                </p>
              )}
              <QuestionContent>{reference.answerMarkdown}</QuestionContent>
              {reference.explanationMarkdown && (
                <QuestionContent>{reference.explanationMarkdown}</QuestionContent>
              )}
              {current.mode === 'written' && subjective && (
                <Field
                  label="本次主观回答判定"
                  hint="判定与回忆评级分别记录；保留未判也可以继续评级。"
                >
                  <select
                    value={verdict}
                    disabled={busy}
                    onChange={(event) => setVerdict(event.target.value)}
                  >
                    <option value="">未判定</option>
                    <option value="correct">正确</option>
                    <option value="partial">部分正确</option>
                    <option value="incorrect">错误</option>
                  </select>
                </Field>
              )}
            </section>
            <section className="focus-rating" aria-label="本次回忆评级">
              <p>根据核对结果，记录这次回忆的质量。</p>
              <div>
                {(['again', 'hard', 'good', 'easy'] as const).map((rating, index) => (
                  <button
                    className={`button focus-rate-${rating}`}
                    type="button"
                    key={rating}
                    disabled={busy || (mustAgain && rating !== 'again')}
                    onClick={() => void act('rate', rating)}
                  >
                    <strong>{REVIEW_RATING_LABELS[rating]}</strong>
                    <span>
                      {
                        ['想不起或有遗漏', '答对但回忆费力', '能正常独立回答', '完整且几乎不费力'][
                          index
                        ]
                      }
                    </span>
                    <kbd>{index + 1}</kbd>
                  </button>
                ))}
              </div>
            </section>
            <div className="focus-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void act('skip')}
              >
                <SkipForward size={16} />
                暂不评级，跳过
              </button>
            </div>
          </>
        )}
      </section>
      <p className="focus-save-status" role="status">
        {busy
          ? '正在保存…'
          : dirty()
            ? '正在暂存输入…'
            : '进度已保存；退出后计时暂停，可从原题集继续。'}
      </p>
    </article>
  );
}
