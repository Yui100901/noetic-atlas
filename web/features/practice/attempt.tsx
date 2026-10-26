import {QuestionContent, SourceNoticeScope, questionNoticeContents} from '../../shared/ui/content-notices';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Clock3, Save } from 'lucide-react';
import type { AnswerVerdict, Attempt, AttemptAnswer, Paper } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils';
import { href, idPath, localDate, request, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, PageHeader, useApp } from '../../shared/ui/components';
import { attemptGrading, legacyPoints, pointText } from '../../shared/lib/scoring';
import { vocabularyDirectionLabel } from '../papers/vocabulary-practice';
import { VocabularyPronunciation } from '../questions/vocabulary-pronunciation';
import { BlankAnswerSummary } from '../questions/question-structure';
import { ExportButton } from '../../shared/export/export-dialog';
import './practice-session.css';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings';
import { AiGradeButton } from '../ai/ai-components';
import { answerState, answerStateLabels, attemptElapsedSeconds, durationText, examExpired, examRemainingSeconds, isAnswerPresent, type AnswerState } from '../../../shared/practice/attempt-timing';
import { notifyExamState } from './exam-guard';
import './exam-guard.css';
import { AttemptReviewControls, AttemptReviewProvider, AttemptReviewSummary } from '../review-scheduler/review-scheduling';

const isAnswered = isAnswerPresent;

export function AttemptPage({ id, embedded = false, onChanged }: { id: string; embedded?: boolean; onChanged?: () => void }) {
  const resource = useResource<Attempt>(`/api/attempts/${idPath(id)}`); const { toast, reload, bootstrap } = useApp(); const settings = bootstrap.settings || DEFAULT_SETTINGS;
  const papers = useResource<Paper[]>(resource.data && resource.data.source !== 'quick' && (resource.data.practiceMode !== 'exam' || resource.data.status === 'submitted') ? '/api/papers?archived=true' : null);
  const [answers, setAnswers] = useState<Record<string, AttemptAnswer>>({}); const [scores, setScores] = useState<Record<string, number | ''>>({}); const [mastery, setMastery] = useState<Record<string, number>>({});
  const [verdicts, setVerdicts] = useState<Record<string, AnswerVerdict | ''>>({});
  const [ready, setReady] = useState(''); const [dirty, setDirty] = useState(false); const [saveState, setSaveState] = useState('草稿已保存'); const [saveError, setSaveError] = useState(''); const [gradeError, setGradeError] = useState(''); const [busy, setBusy] = useState(false);
  const [previewError, setPreviewError] = useState(''); const [previewBusy, setPreviewBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expirySyncRef = useRef(false);
  const answersRef = useRef(answers); const dirtyRef = useRef(false); const readyRef = useRef(false);
  const statusRef = useRef<Attempt['status'] | null>(null); statusRef.current = resource.data?.status ?? null;
  const mountedRef = useRef(true); const submittingRef = useRef(false);
  const inFlightRef = useRef<{ snapshot: Record<string, AttemptAnswer>; promise: Promise<void> } | null>(null);
  const saveLatestRef = useRef<(quiet?: boolean, lifecycle?: boolean) => Promise<void>>(async () => {});
  const loadReview = (attempt: Attempt) => {
    setScores(Object.fromEntries(attempt.questions.filter(question => isSubjectiveType(question.type)).map(question => [question.id, attempt.answers[question.id]?.selfScore ?? ''])));
    setVerdicts(Object.fromEntries(attempt.questions.filter(question => isSubjectiveType(question.type)).map(question => [question.id, attempt.answers[question.id]?.verdict || ''])));
    setMastery(Object.fromEntries(Object.entries(attempt.answers).filter(([, answer]) => answer.mastery !== undefined && answer.mastery !== null).map(([questionId, answer]) => [questionId, answer.mastery as number])));
  };
  useEffect(() => {
    if (resource.data && ready !== id) {
      const restored = resource.data.answers || {}; answersRef.current = restored; dirtyRef.current = false; readyRef.current = true;
      setAnswers(restored); loadReview(resource.data); setReady(id); setDirty(false);
    }
  }, [resource.data, id, ready]);
  useEffect(() => { if (resource.data?.status === 'submitted') loadReview(resource.data); }, [resource.data]);
  const acceptSubmitted = (attempt: Attempt) => {
    statusRef.current = attempt.status;
    if (attempt.status !== 'submitted') return;
    dirtyRef.current = false; answersRef.current = attempt.answers; setAnswers(attempt.answers); setDirty(false); loadReview(attempt); resource.setData(attempt); notifyExamState(attempt); onChanged?.();
  };
  useEffect(() => {
    if (!resource.data || !examExpired(resource.data, clock) || expirySyncRef.current) return;
    expirySyncRef.current = true; submittingRef.current = true; setBusy(true); setSaveState('考试已到时，正在自动交卷…');
    void (async () => {
      try {
        await inFlightRef.current?.promise;
        const result = await send<Attempt>(`/api/attempts/${idPath(id)}/sync`, 'POST');
        if (mountedRef.current) { acceptSubmitted(result); setSaveError(''); toast('考试时间结束，已按到时前保存的作答自动交卷'); reload(); }
      } catch (err) { if (mountedRef.current) setSaveError(`到时交卷未完成，正在重试：${(err as Error).message}`); }
      finally { expirySyncRef.current = false; submittingRef.current = false; if (mountedRef.current) setBusy(false); }
    })();
  }, [clock, id, resource.data?.status, resource.data?.deadlineAt]);
  const save = async (quiet = false, lifecycle = false): Promise<void> => {
    const canSave = () => readyRef.current && statusRef.current === 'in_progress' && !submittingRef.current;
    if (!canSave() || quiet && !dirtyRef.current) return;
    // Serialize draft writes: an older network response must never replace newer input.
    const pending = inFlightRef.current;
    if (pending) {
      await pending.promise;
      if (canSave() && dirtyRef.current && answersRef.current !== pending.snapshot) await saveLatestRef.current(quiet, lifecycle);
      return;
    }
    const snapshot = answersRef.current; const body = JSON.stringify({ answers: snapshot });
    if (mountedRef.current) { setSaveState('正在保存…'); setSaveError(''); }
    const promise = (async () => {
      try {
        // Keep short browser requests alive across pagehide; native requests use the same serialized persistence API.
        const saved = await request<Attempt>(`/api/attempts/${idPath(id)}`, { method: 'PUT', body, ...(lifecycle && new TextEncoder().encode(body).length <= 60000 ? { keepalive: true } : {}) });
        if (saved.status === 'submitted') { if (mountedRef.current) { acceptSubmitted(saved); toast(saved.autoSubmitted ? '考试已到时，已自动交卷' : '本次作答已交卷'); reload(); } return; }
        const current = answersRef.current === snapshot;
        if (current) dirtyRef.current = false;
        if (mountedRef.current) { if (current) setDirty(false); setSaveState(current ? '草稿已保存' : '等待自动保存…'); if (!quiet) toast('草稿已保存，可稍后继续'); onChanged?.(); }
      } catch (err) { if (mountedRef.current) { setSaveState('尚未保存'); setSaveError((err as Error).message); } }
    })();
    inFlightRef.current = { snapshot, promise };
    await promise;
    if (inFlightRef.current?.promise === promise) inFlightRef.current = null;
  };
  saveLatestRef.current = save;
  useEffect(() => { if (!dirty || ready !== id || resource.data?.status !== 'in_progress' || busy) return; const timer = setTimeout(() => void saveLatestRef.current(true), resource.data?.practiceMode === 'exam' ? Math.min(500, settings.autosaveDebounceMs) : settings.autosaveDebounceMs); return () => clearTimeout(timer); }, [answers, dirty, ready, id, busy, resource.data?.status, resource.data?.practiceMode, settings.autosaveDebounceMs]);
  useEffect(() => {
    mountedRef.current = true;
    const flush = () => { if (dirtyRef.current) void saveLatestRef.current(true, true); };
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    const beforeUnload = (event: BeforeUnloadEvent) => { flush(); if (dirtyRef.current && !submittingRef.current) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', flush); window.addEventListener('hashchange', flush); window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mountedRef.current = false; flush();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', flush); window.removeEventListener('hashchange', flush); window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
  const setAnswer = (questionId: string, value: string | string[]) => {
    if (resource.data && examExpired(resource.data)) return;
    const next = { ...answersRef.current, [questionId]: { value } }; answersRef.current = next; dirtyRef.current = true;
    setAnswers(next); setDirty(true); setSaveState('等待自动保存…');
  };
  const submit = async () => {
    if (!resource.data || submittingRef.current || statusRef.current !== 'in_progress') return;
    const remaining = resource.data.questions.filter(question => !isAnswered(answers[question.id])).length;
    if (!confirm(remaining ? `还有 ${remaining} 道题未作答。确定现在交卷？交卷后作答不能修改。` : '确定交卷？提交后将展示答案与解析，作答不能修改。')) return;
    submittingRef.current = true; setBusy(true); setSaveError('');
    try { await inFlightRef.current?.promise; const attempt = await send<Attempt>(`/api/attempts/${idPath(id)}/submit`, 'POST', { answers: answersRef.current }); acceptSubmitted(attempt); toast(attempt.scoring?.enabled === false ? '已交卷，可以核对正误与自测掌握度' : '已交卷，客观题已自动判分；主观题等待阅卷'); reload(); } catch (err) { setSaveError((err as Error).message); } finally { submittingRef.current = false; setBusy(false); }
  };
  const saveReview = async () => {
    if (!resource.data) return; setGradeError(''); const { scoring } = attemptGrading(resource.data);
    if (scoring.enabled) {
      for (const question of resource.data.questions.filter(item => isSubjectiveType(item.type))) {
        const score = scores[question.id]; const maximum = question.points ?? scoring.questionPoints[question.id] ?? legacyPoints[question.type];
        if (score !== '' && score !== undefined && (!Number.isFinite(score) || score < 0 || score > maximum || Math.abs(score * 100 - Math.round(score * 100)) > 1e-6)) { setGradeError(`${question.title}：得分需为 0–${pointText(maximum)} 分，最多保留两位小数。空白表示未评，0 表示已评 0 分。`); return; }
      }
    }
    const body = { ...(scoring.enabled ? { scores: Object.fromEntries(Object.entries(scores).map(([questionId, score]) => [questionId, score === '' ? null : score])) } : { verdicts: Object.fromEntries(Object.entries(verdicts).map(([questionId, verdict]) => [questionId, verdict || null])) }), mastery };
    setBusy(true);
    try { const attempt = await send<Attempt>(`/api/attempts/${idPath(id)}/review`, 'PUT', body); resource.setData(attempt); setAnswers(attempt.answers); loadReview(attempt); toast(scoring.enabled ? '人工阅卷与掌握自评已保存' : subjectiveCount ? '主观判定与掌握自评已保存' : '掌握自评已保存'); reload(); onChanged?.(); } catch (err) { setGradeError((err as Error).message); } finally { setBusy(false); }
  };

  if (resource.loading || ready !== id && !resource.error) return <Loading text="正在恢复本次练习…" />;
  if (resource.error || !resource.data) return <ErrorNotice message={resource.error || '作答记录不存在'} retry={resource.refresh} />;
  const attempt = resource.data; const submitted = attempt.status === 'submitted'; const completed = attempt.questions.filter(question => isAnswered(answers[question.id])).length;
  const { scoring, graded, pending, total } = attemptGrading(attempt); const subjectiveCount = attempt.questions.filter(question => isSubjectiveType(question.type)).length;
  const objectiveQuestions = attempt.questions.filter(question => !isSubjectiveType(question.type));
  const hasReview = subjectiveCount > 0 || Object.keys(mastery).length > 0;
  const correctIds = new Set(objectiveQuestions.filter(question => submitted && getObjectiveCorrect(question, answers[question.id])).map(question => question.id));
  const quick = attempt.source === 'quick' || attempt.paperId === 'quick-practice';
  const deletedPaper = !quick && !!papers.data && !papers.data.some(paper => paper.id === attempt.paperId);
  const returnPath = quick ? '#/quick?tab=history' : `${href('papers', attempt.paperId)}${deletedPaper ? '/activity' : ''}?tab=history`;
  const preview = quick && !!attempt.referenceViewedAt;
  const exam = attempt.practiceMode === 'exam'; const expired = examExpired(attempt, clock);
  const elapsed = attemptElapsedSeconds(attempt, clock), remaining = examRemainingSeconds(attempt, clock);
  const stateFor = (question: Attempt['questions'][number]): AnswerState => submitted && attempt.answerStates?.[question.id] || answerState(question, submitted ? attempt.answers[question.id] : answers[question.id], submitted, scoring.enabled ? question.points ?? scoring.questionPoints[question.id] : undefined);
  const reveal = async () => { setPreviewBusy(true); setPreviewError(''); try { await inFlightRef.current?.promise; if (dirtyRef.current) await saveLatestRef.current(true); resource.setData(await send<Attempt>(`/api/attempts/${idPath(id)}/reveal`, 'POST')); } catch (err) { setPreviewError((err as Error).message); } finally { setPreviewBusy(false); } };
  return <AttemptReviewProvider attempt={attempt}><SourceNoticeScope contents={attempt.questions.flatMap(questionNoticeContents)}>{!embedded && !(exam && !submitted) && <a className="back-link" href={returnPath}><ArrowLeft size={15} />{quick ? '返回随机与单题记录' : '返回题集记录'}</a>}<PageHeader eyebrow={submitted ? 'PRACTICE REVIEW' : 'FOCUS SESSION'} title={attempt.paperTitle} description={`${submitted ? '练习复盘' : '专注练习'} · ${scoring.enabled ? `${scoring.scheme === 'legacy' ? '旧版计分' : '计分练习'} ${pointText(scoring.totalPoints)} 分` : '无分练习'}${quick ? ' · 单题自测' : ` · 版本 v${attempt.paperVersion}`}${attempt.vocabularyDirection ? ` · ${vocabularyDirectionLabel(attempt.vocabularyDirection)}` : ''} · ${localDate(attempt.startedAt)}`} actions={submitted ? <><ExportButton attemptId={attempt.id} />{!quick && !deletedPaper && <a className="button" href={href('papers', attempt.paperId)}>查看题集</a>}</> : <><button className="button" onClick={() => void save()} disabled={busy || expired}><Save size={16} />保存草稿</button><button className="button primary" onClick={submit} disabled={busy || expired}><Check size={16} />{busy ? '正在提交…' : '交卷并查看解析'}</button></>} />
    {!quick && <section className={`attempt-timer ${exam && !submitted && remaining <= 300 ? 'timer-urgent' : ''}`} aria-label={submitted ? '本次作答时间' : exam ? '考试倒计时' : '练习顺计时'}><div><Clock3 size={20} /><span>{submitted ? '作答用时' : exam ? '剩余时间' : '已用时间'}</span><strong data-testid="attempt-clock">{durationText(exam && !submitted ? remaining : elapsed)}</strong></div><p className="muted">{submitted ? `${exam ? '考试模式' : '普通练习'}${attempt.autoSubmitted ? ' · 到时自动交卷' : ' · 已提交'}` : exam ? `限时 ${attempt.durationMinutes} 分钟；到时自动交卷，刷新与离开不会暂停计时。` : '从开始练习到交卷持续计时，草稿恢复后继续累计。'}</p></section>}
    {deletedPaper && <div className="notice info">原题集已删除；本次作答仍使用独立快照，可以继续答题、阅卷和复盘。</div>}<div className="attempt-progress card"><div><span className="section-label">{submitted ? '本次练习结果' : '本次练习进度'}</span><strong>{completed}<small> / {attempt.questions.length} 题已作答</small></strong></div>{submitted ? scoring.enabled ? <div className="score-summary scored-summary"><div>客观题<strong>{pointText(attempt.objectiveScore)}<small> / {pointText(attempt.objectiveMax)} 分</small></strong></div><div>{pending ? '主观阅卷中' : '主观得分'}<strong>{pointText(attempt.subjectiveScore)}<small> / {pointText(attempt.subjectiveMax)} 分</small></strong><span>{graded} 已评{pending > 0 ? ` · ${pending} 待阅` : ''}</span></div><div>{total === null ? '总成绩待阅卷完成' : '最终总分'}<strong>{total === null ? '—' : pointText(total)}<small> / {pointText(scoring.totalPoints)} 分</small></strong></div></div> : <div className="unscored-result"><span className="badge">无分练习</span><strong>客观题答对 {correctIds.size} / {objectiveQuestions.length} 题</strong><span>不计算总分，可以继续核对解析与自测掌握度。</span></div> : <div className="progress-content"><div className="progress-bar"><span style={{ width: `${attempt.questions.length ? completed / attempt.questions.length * 100 : 0}%` }} /></div><span className="muted" role="status">{saveState}</span></div>}</div>
    {quick && !submitted && <div className="quick-answer-preview"><button className="button" disabled={previewBusy} onClick={() => void reveal()}><BookOpen size={16} />{previewBusy ? '正在读取…' : preview ? '已展开参考解析' : '先看参考解析'}</button><span className="muted">查看解析不会提交本次作答，也不会添加错题记录。</span></div>}{previewError && <ErrorNotice message={previewError} />}{preview && !submitted && <div className="notice info">本次已查看参考解析。你仍可完成作答并提交，建议按真实情况记录掌握程度。</div>}
    {saveError && <ErrorNotice message={saveError} retry={() => void save()} />}
    {submitted && <div className="notice info">{scoring.enabled ? `客观题按本次试卷分值自动判分，多选需全对。主观题逐题人工评分：空白为未评，填 0 则是已评 0 分。${pending ? `当前 ${pending} 道主观题待阅，尚不生成最终总分。` : '主观题已完成阅卷。'}掌握程度与试卷得分独立记录。` : '本次为无分练习，不计算总分。客观题仍显示正误，主观题可人工判为正确、部分正确、错误或未判；0–3级掌握自评独立保存。'}</div>}
    {submitted && subjectiveCount > 0 && <div className="ai-review-toolbar"><div><strong>AI辅助评价</strong><p>生成建议分与改进意见，核对后可应用成绩或追加学习笔记。</p></div><AiGradeButton attempt={attempt} onApplied={updated => { if(updated)resource.setData(updated);else resource.refresh(); onChanged?.(); }} /></div>}

    {submitted && <AttemptReviewSummary />}
    <div className="attempt-layout"><div className="attempt-questions">{attempt.questions.map((question, index) => {
      const answer = answers[question.id]?.value; const options = question.type === 'true_false' ? [{ key: 'true', text: '对 / 正确' }, { key: 'false', text: '错 / 错误' }] : question.options;
      const currentState = stateFor(question); const correct = correctIds.has(question.id); const maximum = question.points ?? scoring.questionPoints[question.id] ?? legacyPoints[question.type]; const persistedScore = attempt.answers[question.id]?.selfScore; const isGraded = persistedScore !== undefined && persistedScore !== null;
      return <section className="card exam-question" id={`exam-${index + 1}`} key={question.id}><div className="exam-heading"><span className={`number-label status-${currentState}`}>{String(index + 1).padStart(2, '0')}</span><div><div className="question-meta"><span className="type-badge">{typeLabels[question.type]}</span><span>D{question.difficulty} / L{question.depth}</span>{scoring.enabled && <span className="question-points">本题 {pointText(maximum)} 分</span>}{submitted && !isSubjectiveType(question.type) && <span className={`answer-state-text status-${currentState}`}>{answerStateLabels[currentState]}{scoring.enabled ? ` · ${correct ? pointText(maximum) : 0} 分` : ''}</span>}{submitted && isSubjectiveType(question.type) && <span className={`answer-state-text status-${currentState}`}>{answerStateLabels[currentState]}{scoring.enabled && isGraded ? ` · 已评 ${pointText(persistedScore)} 分` : ''}</span>}</div><h2>{question.title}</h2></div></div>
        {question.groupId && (index === 0 || attempt.questions[index - 1].groupId !== question.groupId) && <section className="group-material"><span className="section-label">共用材料 · {question.groupTitle}</span><QuestionContent>{question.groupStemMarkdown || ''}</QuestionContent></section>}<QuestionContent>{question.stemMarkdown}</QuestionContent>
        {isSubjectiveType(question.type) ? <Field label={question.type === 'essay' ? '我的长文回答' : '我的回答'}><textarea rows={question.type === 'essay' ? 12 : 6} disabled={submitted || busy || expired} value={typeof answer === 'string' ? answer : ''} onChange={event => setAnswer(question.id, event.target.value)} placeholder={question.type === 'essay' ? '写出论点、结构、推理依据和结论，可使用 Markdown…' : '用自己的话解释原理、边界和例子…'} /></Field> : question.type === 'fill_blank' ? <div className="blank-answer-fields">{question.blanks?.map((blank, blankIndex) => <Field key={blank.id} label={`${blankIndex + 1}. ${blank.label || '填空'}`}><input disabled={submitted || busy || expired} value={Array.isArray(answer) ? answer[blankIndex] || '' : ''} onChange={event => { const values = question.blanks!.map((_, i) => Array.isArray(answer) ? answer[i] || '' : ''); values[blankIndex] = event.target.value; setAnswer(question.id, values); }} autoComplete="off" /></Field>)}</div> : <fieldset className="answer-options" disabled={submitted || busy || expired}><legend className="sr-only">{question.title}，{typeLabels[question.type]}</legend>{options.map(option => { const checked = Array.isArray(answer) ? answer.includes(option.key) : answer === option.key; const isCorrectOption = submitted && question.correctAnswers?.includes(option.key); return <label className={`answer-option ${checked ? 'chosen' : ''} ${isCorrectOption ? 'correct-option' : ''}`} key={option.key}><input name={`answer-${question.id}`} type={question.type === 'multiple_choice' ? 'checkbox' : 'radio'} checked={checked} onChange={() => setAnswer(question.id, question.type === 'multiple_choice' ? checked ? (Array.isArray(answer) ? answer : []).filter(value => value !== option.key) : [...(Array.isArray(answer) ? answer : []), option.key].sort() : option.key)} /><span className="option-letter">{question.type === 'true_false' ? '' : option.key}</span><QuestionContent>{option.text}</QuestionContent>{isCorrectOption && <Check size={16} />}</label>; })}</fieldset>}
        {preview && !submitted && <section className="attempt-answer preview-answer"><span className="section-label">参考答案与解析 · 已提前查看</span><VocabularyPronunciation vocabulary={question.vocabulary} /><BlankAnswerSummary blanks={question.blanks} /><QuestionContent>{question.answerMarkdown || ''}</QuestionContent><QuestionContent>{question.explanationMarkdown || ''}</QuestionContent></section>}
        {submitted && <details className="attempt-answer" open={!isSubjectiveType(question.type) && !correct}><summary>参考答案与解析 {question.correctAnswers?.length ? `· ${question.correctAnswers.map(value => value === 'true' ? '对' : value === 'false' ? '错' : value).join('、')}` : ''}</summary><div><VocabularyPronunciation vocabulary={question.vocabulary} /><BlankAnswerSummary blanks={question.blanks} /><QuestionContent>{question.answerMarkdown || ''}</QuestionContent><QuestionContent>{question.explanationMarkdown || ''}</QuestionContent></div></details>}
        {submitted && <div className="ai-actions"><a className="button feature-entry" href={`${href('questions', question.sourceQuestionId)}?answer=1${question.partId ? `&part=${idPath(question.partId)}` : ''}`}><BookOpen size={16} />查看原题与学习笔记</a>{isSubjectiveType(question.type) && <AiGradeButton attempt={attempt} questionIds={[question.id]} label="AI评价本题" onApplied={updated => { if(updated)resource.setData(updated);else resource.refresh(); onChanged?.(); }} />}</div>}{submitted && scoring.enabled && isSubjectiveType(question.type) && <div className="human-grade"><div><span className="section-label">人工阅卷</span><p>满分 {pointText(maximum)} 分。留空表示未评或撤销判分，0 分表示已完成阅卷。</p></div><div className="human-grade-controls"><Field label={`${question.id} 人工得分`}><input type="number" inputMode="decimal" min={0} max={maximum} step="0.01" value={scores[question.id] ?? ''} placeholder="未评" disabled={busy} onChange={event => setScores(old => ({ ...old, [question.id]: event.target.value === '' ? '' : Number(event.target.value) }))} /></Field><button className="text-button" disabled={busy} onClick={() => setScores(old => ({ ...old, [question.id]: '' }))}>设为未评</button><button className="text-button" disabled={busy} onClick={() => setScores(old => ({ ...old, [question.id]: maximum }))}>填入满分</button></div></div>}
        {submitted && !scoring.enabled && isSubjectiveType(question.type) && <div className="human-grade"><div><span className="section-label">主观题人工判定</span><p>核对参考答案后判定；无需填写分数，保存后更新本次复习安排。关键遗漏可判部分正确；设为未判会撤销本次自动回忆事件。</p></div><div className="segmented" role="group" aria-label={`${question.id} 主观题判定`}>{([['','未判'],['correct','正确'],['partial','部分正确'],['incorrect','错误']] as const).map(([value,label]) => <button type="button" key={value || 'ungraded'} disabled={busy} className={(verdicts[question.id] || '') === value ? 'selected' : ''} onClick={() => setVerdicts(before => ({ ...before, [question.id]: value }))}>{label}</button>)}</div></div>}
        {submitted && <div className="self-score"><span>自测掌握度（独立于得分）</span><div className="segmented">{[0, 1, 2, 3].map(value => <button key={value} disabled={busy} className={mastery[question.id] === value ? 'selected' : ''} onClick={() => setMastery(old => ({ ...old, [question.id]: value }))}>{value} · {['不会', '需提示', '能独立', '能深入'][value]}</button>)}</div></div>}
        {submitted && <AttemptReviewControls leafId={question.id} onChanged={onChanged} />}
      </section>;
    })}{submitted && <>{gradeError && <ErrorNotice message={gradeError} />}<div className="sticky-submit"><span className="muted">{scoring.enabled && subjectiveCount > 0 ? `主观题已保存判分 ${graded}/${subjectiveCount} · 待阅 ${pending} 题` : `已选择 ${Object.keys(mastery).length} 道题的掌握程度`}</span><button className="button primary" onClick={() => void saveReview()} disabled={busy || !hasReview}><Save size={16} />{scoring.enabled && subjectiveCount > 0 ? '保存人工阅卷与自评' : subjectiveCount > 0 ? '保存主观判定与自评' : '保存掌握自评'}</button></div></>}
    </div><aside className="card question-navigator"><h3>答题卡</h3><div>{attempt.questions.map((question, index) => { const state = stateFor(question); return <a key={question.id} className={`status-${state}`} aria-label={`第${index + 1}题 · ${answerStateLabels[state]}`} title={`第${index + 1}题 · ${answerStateLabels[state]}`} data-answer-state={state} href={`#exam-${index + 1}`} onClick={event => { event.preventDefault(); document.getElementById(`exam-${index + 1}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{index + 1}</a>; })}</div><div className="answer-status-legend">{(submitted ? ['unanswered', 'correct', 'partial', 'incorrect', 'ungraded'] : ['unanswered', 'answered']).map(state => <span key={state}><i className={`status-${state}`} />{answerStateLabels[state as AnswerState]}</span>)}</div><p className="muted">{submitted ? '点击序号定位题目；主观题分别显示正确、部分正确、错误或未判定。' : exam ? '考试中不能切换其他功能。计时结束按已保存答案自动交卷。' : '草稿每次更改后自动保存。离开前也可手动保存。'}</p>{!submitted && <button className="button primary navigator-submit" onClick={submit} disabled={busy || expired}><Check size={16} />{expired ? '正在到时交卷…' : busy ? '正在提交…' : '交卷并查看解析'}</button>}</aside></div>
  </SourceNoticeScope></AttemptReviewProvider>;
}
