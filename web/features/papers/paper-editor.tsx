import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Eye, RotateCcw, Shuffle, X } from 'lucide-react';
import type { Question, Paper, PaperDetail, PaperFilters, QuestionPage, QuestionType, ScoringInput } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import { ApiError, href, idPath, navigate, request, send, useDebounced, useResource } from '../../shared/lib/api';
import { TagPicker } from '../../shared/ui/tag-picker';
import { CategoryOptions, Empty, ErrorNotice, Field, Loading, MultiSelect, PageHeader, Pagination, SaveButton, useApp } from '../../shared/ui/components';
import { emptyFilters, FiltersPanel, questionQuery, QuestionRow, QuestionPreview, type Filters } from '../questions/questions';
import { paperScoring, pointNumber, pointText, ScoringBreakdown, validPoints } from '../../shared/lib/scoring';
import { usePaperDraft } from './use-paper-draft';
import type { PaperDraftState } from '../../../shared/practice/paper-drafts';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings';
import { normalizePaperFilters, normalizeQuestionFilters } from '../../shared/lib/learning-filters';
import { usePagination } from '../../shared/lib/pagination';
import './paper-editor.css';

function TypePointFields({ values, onChange }: { values: Record<QuestionType, number>; onChange: (values: Record<QuestionType, number>) => void }) {
  return <div className="type-point-grid">{(Object.keys(typeLabels) as QuestionType[]).map(type => <Field key={type} label={`${typeLabels[type]}默认分值`}><input type="number" inputMode="decimal" step="0.01" min="0.01" max="1000" value={Number.isFinite(values[type]) ? values[type] : ''} onChange={event => onChange({ ...values, [type]: event.target.value === '' ? NaN : Number(event.target.value) })} /></Field>)}</div>;
}

export function PaperEditor({ mode: initialMode = 'manual', id }: { mode?: 'manual' | 'random'; id?: string }) {
  const { toast, reload, bootstrap } = useApp(); const settings = bootstrap.settings || DEFAULT_SETTINGS;
  const existing = useResource<PaperDetail>(id ? `/api/papers/${idPath(id)}?summary=true` : null);
  const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [mode, setMode] = useState(initialMode);
  const [practiceKind, setPracticeKind] = useState<'standard' | 'vocabulary' | 'concept'>('standard');
  const [organization, setOrganization] = useState<'domain' | 'other'>('other'); const [organizationDomainId, setOrganizationDomainId] = useState('');
  const [ids, setIds] = useState<string[]>([]); const [titles, setTitles] = useState<Record<string, string>>({}); const [types, setTypes] = useState<Record<string, QuestionType>>({});
  const [statuses,setStatuses]=useState<Record<string,Question['status']|'missing'>>({});
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters }); const [page, setPage] = useState(1); const [pageSize,setPageSize]=useState(20); const debounced = useDebounced(filters);
  const questions = useResource<QuestionPage>(mode === 'manual' ? questionQuery(debounced, page, pageSize) : null);
  const [random, setRandom] = useState<PaperFilters>({ tagIds: [], tagMode: 'all', types: [], collection: 'all', difficultyMin: 1, difficultyMax: 4, frequencyMin: 0 });
  const [count, setCount] = useState(settings.randomQuestionCount); const [enabled, setEnabled] = useState(settings.scoringEnabledByDefault); const [total, setTotal] = useState(settings.randomTotalPoints); const [objectivePercent, setObjectivePercent] = useState(settings.objectivePercent);
  const [pointsByType, setPointsByType] = useState<Record<QuestionType, number>>({ ...settings.pointsByType }); const [overrides, setOverrides] = useState<Record<string, number>>({}); const [autoTotal, setAutoTotal] = useState(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [preview, setPreview] = useState<PaperDetail | null>(null); const [previewBusy, setPreviewBusy] = useState(false); const [previewError, setPreviewError] = useState('');
  useEffect(() => {
    if (!existing.data) return;
    const paper = existing.data; const scoring = paperScoring(paper);
    const parentTitles: Record<string, string> = {}, parentTypes: Record<string, QuestionType> = {}, parentPoints: Record<string, number> = {};
    for (const question of paper.questions) {
      const parent = question.groupId || question.id;
      parentTitles[parent] = question.groupTitle || question.title;
      parentTypes[parent] = question.groupId ? 'group' : question.type;
      parentPoints[parent] = pointNumber((parentPoints[parent] || 0) + (scoring.questionPoints[question.id] ?? question.points ?? 0));
    }
    setTitle(paper.title); setDescription(paper.description); setPracticeKind(paper.practiceKind || 'standard'); setIds(paper.questionIds); setTitles(parentTitles); setTypes(parentTypes); setMode('manual'); setOrganization(paper.organization || 'other'); setOrganizationDomainId(paper.domainId || '');
    setEnabled(scoring.enabled); setTotal(scoring.totalPoints || settings.randomTotalPoints); setObjectivePercent(scoring.objectivePercent); setPointsByType(scoring.enabled ? scoring.pointsByType : { ...settings.pointsByType }); setOverrides(scoring.enabled ? parentPoints : {}); setAutoTotal(false);
  }, [existing.data]);
  useEffect(() => {
    if (!questions.data) return;
    setTitles(old => ({ ...old, ...Object.fromEntries(questions.data!.items.map(question => [question.id, question.title])) }));
    setTypes(old => ({ ...old, ...Object.fromEntries(questions.data!.items.map(question => [question.id, question.type])) }));setStatuses(old=>({...old,...Object.fromEntries(questions.data!.items.map(question=>[question.id,question.status]))}));
  }, [questions.data]);
  const draftState:PaperDraftState={title,description,mode,practiceKind,organization,domainId:organizationDomainId,questionIds:ids,filters:{...normalizeQuestionFilters(filters)},random:normalizePaperFilters(random),count:Number.isFinite(count)?count:0,enabled,total:Number.isFinite(total)?total:0,objectivePercent:Number.isFinite(objectivePercent)?objectivePercent:0,pointsByType:Object.fromEntries(Object.entries(pointsByType).map(([key,value])=>[key,Number.isFinite(value)?value:0])) as Record<QuestionType,number>,overrides:Object.fromEntries(Object.entries(overrides).map(([key,value])=>[key,Number.isFinite(value)?value:0])),autoTotal};
  const restoreDraft=(state:PaperDraftState)=>{setTitle(state.title);setDescription(state.description);setPracticeKind(state.practiceKind || 'standard');setMode(state.mode);setOrganization(state.organization);setOrganizationDomainId(state.domainId);setIds(state.questionIds);setFilters(normalizeQuestionFilters(state.filters));setRandom(normalizePaperFilters(state.random));setCount(state.count);setEnabled(state.enabled);setTotal(state.total);setObjectivePercent(state.objectivePercent);setPointsByType(state.pointsByType);setOverrides(state.overrides);setAutoTotal(state.autoTotal);setPage(1);};
  const authoring=usePaperDraft({context:id||'new',state:draftState,restore:restoreDraft,delay:settings.autosaveDebounceMs,maximum:settings.maxPaperDrafts,ready:!id||Boolean(existing.data)});
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [metadataRevision, setMetadataRevision] = useState(0);
  // Membership, not presentation order, determines which live statuses need
  // checking. Reordering a 10,000-word set must not cause 10,000 more requests.
  const metadataKey = useMemo(() => JSON.stringify([...ids].sort()), [ids]);
  const [validatedMetadataKey, setValidatedMetadataKey] = useState('[]');
  const metadataReady = mode !== 'manual' || !ids.length || (!metadataBusy && !metadataError && validatedMetadataKey === metadataKey);
  useEffect(() => {
    let cancelled = false; const controller = new AbortController();
    const selectedIds: string[] = JSON.parse(metadataKey);
    setMetadataError('');
    if (!selectedIds.length) { setMetadataBusy(false); setValidatedMetadataKey(metadataKey); return; }
    setMetadataBusy(true);
    void request<{ items: Array<Pick<Question, 'id' | 'title' | 'type' | 'status'>>; missingIds: string[] }>('/api/questions/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selectedIds }), signal: controller.signal }).then(result => {
      if (cancelled) return;
      const nextTitles: Record<string, string> = {}, nextTypes: Record<string, QuestionType> = {}, nextStatuses: Record<string, Question['status'] | 'missing'> = {};
      for (const item of result.items) { nextTitles[item.id] = item.title; nextTypes[item.id] = item.type; nextStatuses[item.id] = item.status; }
      for (const missing of result.missingIds) nextStatuses[missing] = 'missing';
      setTitles(previous => ({ ...previous, ...nextTitles })); setTypes(previous => ({ ...previous, ...nextTypes })); setStatuses(previous => ({ ...previous, ...nextStatuses }));
      setValidatedMetadataKey(metadataKey);
    }).catch(reason => { if (!cancelled && reason.name !== 'AbortError') setMetadataError(`无法核对已选题目：${reason.message}。表单与排序已保留，请重试。`); }).finally(() => { if (!cancelled) setMetadataBusy(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [metadataKey, metadataRevision]);
  const basketPaging = usePagination(ids, id || 'new');
  const selectedIds = useMemo(() => new Set(ids), [ids]);
  const questionPoints = useMemo(() => Object.fromEntries(ids.map(questionId => [questionId, overrides[questionId] ?? pointsByType[types[questionId] || 'short_answer']])), [ids, overrides, pointsByType, types]);
  const sum = useMemo(() => pointNumber(ids.reduce((result, questionId) => result + questionPoints[questionId], 0)), [ids, questionPoints]);
  const target = mode === 'manual' && autoTotal ? sum : total;
  const difference = pointNumber(target - sum);
  const configKey = JSON.stringify({ mode, practiceKind, random, count, enabled, total, objectivePercent, pointsByType }); const latestConfig = useRef(configKey); latestConfig.current = configKey;
  useEffect(() => { setPreview(null); setPreviewError(''); }, [configKey]);
  const randomSet = <K extends keyof PaperFilters>(key: K, value: PaperFilters[K]) => setRandom(old => ({ ...old, [key]: value, ...(key === 'domainId' ? { categoryId: '' } : {}) }));
  const toggle = (questionId: string) => setIds(old => old.includes(questionId) ? old.filter(value => value !== questionId) : [...old, questionId]);
  const move = (index: number, direction: number) => setIds(old => { const next = [...old]; const targetIndex = index + direction; if (targetIndex < 0 || targetIndex >= next.length) return old; [next[index], next[targetIndex]] = [next[targetIndex], next[index]]; return next; });
  const validate = () => {
    if (organization === 'domain' && !organizationDomainId) return '请为领域专项选择所属领域。';
    if (mode === 'manual' && !ids.length) return '请至少选择一道题目。';
    if(mode==='manual'&&ids.some(questionId=>statuses[questionId]&&statuses[questionId]!=='published'))return '已选题目中有题目不再处于已发布状态，请移除或更换后再创建题集。组题草稿仍可继续保存。';
    if (mode === 'random' && !enabled && (count < 1 || count > 500 || !Number.isInteger(count))) return '随机题量需为 1–500 的整数。';
    if ((random.difficultyMin || 1) > (random.difficultyMax || 4)) return '最低难度不能高于最高难度。';
    if (!enabled) return '';
    if (!validPoints(target, 10000)) return '总分需为 0.01–10000 之间的数值，最多保留两位小数。';
    if (Object.values(pointsByType).some(value => !validPoints(value))) return '各题型默认分值需为 0.01–1000，最多保留两位小数。';
    if (mode === 'manual' && ids.some(questionId => !validPoints(questionPoints[questionId]))) return '每题分值需为 0.01–1000，最多保留两位小数。';
    if (mode === 'manual' && Math.round(target * 100) !== Math.round(sum * 100)) return `逐题分值合计 ${pointText(sum)} 分，与题集总分 ${pointText(target)} 分不一致。`;
    if (mode === 'random' && (!Number.isFinite(objectivePercent) || objectivePercent < 0 || objectivePercent > 100)) return '客观题目标占比需为 0–100%。';
    return '';
  };
  const payload = (forPreview = false) => {
    const scoring: ScoringInput = !enabled ? { enabled: false } : mode === 'manual' ? { enabled: true, totalPoints: target, questionPoints, pointsByType } : { enabled: true, totalPoints: total, objectivePercent, pointsByType };
    return { title: title.trim() || (forPreview ? '随机组题预览' : ''), description, mode, practiceKind, organization, domainId: organization === 'domain' ? organizationDomainId : null, scoring, ...(mode === 'manual' ? { questionIds: ids } : { filters: normalizePaperFilters(random), ...(!enabled ? { count } : {}) }) };
  };
  const errorMessage = (err: unknown) => { let message = (err as Error).message; if (err instanceof ApiError && err.details && typeof err.details === 'object' && 'available' in err.details) message += `（当前满足条件：${String((err.details as { available: unknown }).available)} 道）`; return message; };
  const showPreview = async () => { const issue = validate(); if (issue) { setPreviewError(issue); return; } setPreviewBusy(true); setPreviewError(''); const requested = configKey; try { const paper = await send<PaperDetail>('/api/papers/preview', 'POST', payload(true)); if (latestConfig.current === requested) setPreview(paper); } catch (err) { if (latestConfig.current === requested) setPreviewError(errorMessage(err)); } finally { setPreviewBusy(false); } };
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); if (!title.trim()) { setError('请为题集取一个名称。'); return; } const issue = validate(); if (issue) { setError(issue); return; } if(!metadataReady){setError(metadataError || '正在核对已选题目，请稍候。');return;} setBusy(true); try { const result = await send<Paper>(id ? `/api/papers/${idPath(id)}` : '/api/papers', id ? 'PUT' : 'POST', payload()); try{await authoring.completed();}catch{toast('题集已保存，但组题草稿清理失败，可稍后删除。',true);} toast(id ? '题集已更新；历史作答快照保持不变' : '题集已创建'); reload(); navigate('papers', result.id); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  if (id && existing.loading) return <Loading />;
  if (existing.error) return <ErrorNotice message={existing.error} retry={existing.refresh} />;
  return <><a className="back-link" href={id ? href('papers', id) : '#/papers'}><ArrowLeft size={15} />返回题集</a><PageHeader eyebrow="BUILD YOUR PRACTICE" title={id ? '调整这份题集。' : mode === 'manual' ? '为重要的知识，建立一份题集。' : '用标签，组合一次新的挑战。'} description={id ? existing.data?.archived ? '保存后将恢复这套练习，并创建新版本；已开始的练习保留原题快照。' : '修改会创建新版本，已经开始的练习保留原题与计分快照。' : '题集可用于浏览、练习、考试和导出；默认题量与分值可在这里调整。'} actions={<><button type="button" className="button" disabled={!authoring.initialized||busy} onClick={()=>void authoring.saveNow().catch(()=>{})}>保存组题草稿</button><button type="submit" form="paper-editor-form" className="button primary" disabled={!authoring.initialized||busy||!metadataReady}>{busy?'正在保存…':id?'保存题集':'创建题集'}</button></>} />
    {authoring.status}{authoring.picker}<form id="paper-editor-form" onSubmit={submit}><fieldset className="authoring-form-fieldset" disabled={!authoring.initialized||busy}>
      <section className="card form-stack paper-meta-form">{error && <ErrorNotice message={error} />}<div className="form-grid"><Field label="题集名称 *"><input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：基础概念 · 第一轮复习" /></Field><Field label="练习目标"><input value={description} onChange={event => setDescription(event.target.value)} placeholder="这次我想检验哪些知识？" /></Field></div>
        <div className="form-grid"><Field label="题集类型"><select aria-label="题集类型" value={practiceKind} onChange={event => setPracticeKind(event.target.value as 'standard' | 'vocabulary' | 'concept')}><option value="standard">通用题集</option><option value="vocabulary">词汇题集</option><option value="concept">概念题集</option></select></Field><Field label="题集组织"><select aria-label="题集组织" value={organization} onChange={event => setOrganization(event.target.value as 'domain' | 'other')}><option value="other">其他题集</option><option value="domain">领域专项</option></select></Field>{organization === 'domain' && <Field label="专项所属领域 *" hint="用于组织题集，不会自动改变选题筛选范围。"><select required aria-label="专项所属领域" value={organizationDomainId} onChange={event => setOrganizationDomainId(event.target.value)}><option value="">选择领域</option>{bootstrap.domains.map(domain => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></Field>}</div>{practiceKind === 'vocabulary' && <p className="notice info">词汇题集只收录带读音和独立释义的英语／日语词卡。开始练习或考试时可选择顺向或逆向；语法题和普通知识题请使用通用题集。</p>}{practiceKind === 'concept' && <p className="notice info">概念题集只收录带主词、独立定义及可接受别称的概念简答卡。开始练习可选择“看概念想含义”或“看描述想概念”。</p>}{!id && <div className="segmented"><button type="button" className={mode === 'manual' ? 'selected' : ''} onClick={() => setMode('manual')}><Check size={15} />手动选题</button><button type="button" className={mode === 'random' ? 'selected' : ''} onClick={() => setMode('random')}><Shuffle size={15} />标签随机</button></div>}
        <div className="scoring-switch-row"><label className="scoring-switch"><input type="checkbox" aria-label="启用计分" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span><strong>启用计分</strong><small>{enabled ? '客观题自动判分，主观题交卷后人工阅卷。' : '不设置总分，专注正误核对与掌握程度。'}</small></span></label><span className="badge">{enabled ? '计分练习' : '无分练习'}</span></div>
        {enabled && <div className="scoring-settings"><div className="form-grid"><Field label="题集总分" hint={mode === 'manual' ? autoTotal ? '当前随逐题分值合计，可手动设定总分。' : '总分必须与逐题分值合计一致。' : `系统默认 ${pointText(settings.randomTotalPoints)} 分，题量由每题分值与筛选条件计算。`}><input type="number" inputMode="decimal" step="0.01" min="0.01" max="10000" value={Number.isFinite(target) ? target : ''} onChange={event => { setAutoTotal(false); setTotal(event.target.value === '' ? NaN : Number(event.target.value)); }} /></Field>{mode === 'random' ? <Field label="客观题目标占比（%）" hint={`主观题目标占比 ${Number.isFinite(objectivePercent) ? pointText(100 - objectivePercent) : '—'}%；系统默认客观 ${pointText(settings.objectivePercent)}% / 主观 ${pointText(100 - settings.objectivePercent)}%。`}><input type="number" inputMode="decimal" min="0" max="100" step="0.01" value={Number.isFinite(objectivePercent) ? objectivePercent : ''} onChange={event => setObjectivePercent(event.target.value === '' ? NaN : Number(event.target.value))} /></Field> : <div className={`manual-score-check ${difference !== 0 || !Number.isFinite(target) ? 'score-mismatch' : ''}`} aria-live="polite"><span>逐题合计 <strong>{pointText(sum)} 分</strong></span><span>{!Number.isFinite(target) ? '请输入总分' : difference === 0 ? '与总分一致' : difference > 0 ? `还差 ${pointText(difference)} 分` : `超出 ${pointText(-difference)} 分`}</span><button className="text-button" type="button" onClick={() => setAutoTotal(true)}>以逐题合计为总分</button></div>}</div><div className="score-default-heading"><span className="field-label">题型默认分值 · 选用即可，无需逐次填写</span><button className="text-button" type="button" onClick={() => { setPointsByType({ ...settings.pointsByType }); if (mode === 'manual') { setOverrides({}); setAutoTotal(true); } }}><RotateCcw size={12} />恢复默认</button></div><TypePointFields values={pointsByType} onChange={setPointsByType} />{mode === 'manual' && <p className="scoring-help">每道已选题目可单独调整分值。已单独修改的题目不受题型默认值变化影响。</p>}{mode === 'random' && <p className="scoring-help">系统先满足总分，再寻找最接近目标占比的题目组合。实际题量与占比请预览；无法组合时会明确提示。</p>}</div>}
      </section>
      {mode === 'manual' ? <div className="picker-layout"><section><FiltersPanel compact filters={filters} onChange={value => { setFilters(value); setPage(1); }} /><div className="result-heading"><span>候选题目 {questions.data?.total ?? '—'} 道</span><span className="muted">选中状态跨页保留</span></div>{questions.loading ? <Loading /> : questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : questions.data?.items.length ? <><div className="question-list">{questions.data.items.map(question => <QuestionRow key={question.id} question={question} selectable checked={selectedIds.has(question.id)} onCheck={() => toggle(question.id)} />)}</div><Pagination page={page} pageSize={pageSize} onPageSize={size=>{setPageSize(size);setPage(1);}} total={questions.data.total} onPage={setPage} /></> : <Empty title="没有符合条件的题目" />}</section>
        <aside className="card selection-basket">{metadataError && <ErrorNotice message={metadataError} retry={() => setMetadataRevision(value => value + 1)} />}{metadataBusy && <p className="muted" role="status">正在批量核对 {ids.length.toLocaleString()} 道已选题目…</p>}<div className="basket-title"><h2>已选题目 <span>{ids.length}</span></h2><button className="text-button" type="button" onClick={() => setIds([])} disabled={!ids.length}>清空</button></div><p className="muted">用箭头调整题目顺序。{enabled && '逐题分值实时合计。'}</p>{enabled && <div className={`basket-score-total ${difference !== 0 ? 'score-mismatch' : ''}`} aria-live="polite"><span>合计 / 总分</span><strong>{pointText(sum)} / {pointText(target)}</strong><small>分</small></div>}
          <ol className="selected-questions" start={(basketPaging.page - 1) * basketPaging.pageSize + 1}>{basketPaging.items.map((questionId, pageIndex) => { const index = (basketPaging.page - 1) * basketPaging.pageSize + pageIndex; return <li key={questionId}><div><span>{index + 1}. <code>{questionId}</code></span><SelectedQuestionPreview id={questionId} title={titles[questionId] || questionId}/>{statuses[questionId]&&statuses[questionId]!=='published'&&<span className="danger-text">题目已不可用于组题，请移除或更换。</span>}{enabled && <label className="question-point-input"><span>本题分值</span><input aria-label={`${questionId} 分值`} type="number" inputMode="decimal" min="0.01" max="1000" step="0.01" value={Number.isFinite(questionPoints[questionId]) ? questionPoints[questionId] : ''} onChange={event => setOverrides(old => ({ ...old, [questionId]: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label>}</div><div className="tiny-actions"><button type="button" aria-label="上移" disabled={!index} onClick={() => move(index, -1)}><ArrowUp size={13} /></button><button type="button" aria-label="下移" disabled={index === ids.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button><button type="button" aria-label="移除题目" onClick={() => toggle(questionId)}><X size={13} /></button></div></li>; })}</ol><Pagination {...basketPaging} label="已选题目" />{!ids.length && <p className="muted basket-empty">从左侧勾选题目，逐步构建练习。</p>}
        </aside></div> : <div className="random-layout"><section className="card form-stack"><RandomFilters random={random} set={randomSet} />{!enabled && <Field label="题目数量" hint="无分练习按题量抽取，题量不足会提示，不会自动放宽条件。"><input type="number" inputMode="numeric" required min={1} max={500} value={count} onChange={event => setCount(Number(event.target.value))} /></Field>}
          <div className="random-submit-actions"><button type="button" className="button" onClick={() => void showPreview()} disabled={previewBusy || busy}><Eye size={16} />{previewBusy ? '正在计算…' : '预览组题构成'}</button><SaveButton busy={busy}>{enabled ? '按分值随机生成题集' : '随机生成题集'}</SaveButton></div>{previewError && <ErrorNotice message={previewError} />}
          {preview && <section className="random-preview" aria-live="polite"><h3>可生成的练习构成</h3><ScoringBreakdown scoring={paperScoring(preview)} questionCount={preview.questionCount} compact /><p className="muted">{preview.questionCount} 个选题单位 · {preview.answerCount ?? preview.questions.length} 个独立作答项；组合题按整组抽取。</p><div className="preview-type-counts">{Object.entries(typeLabels).map(([type, label]) => { const items = preview.questions.filter(question => question.type === type); return <div key={type}><span>{label}</span><strong>{items.length} 题</strong>{enabled && <small>{pointText(items.reduce((value, question) => value + (question.points || 0), 0))} 分</small>}</div>; })}</div>{enabled && <p className="scoring-help">目标占比：客观 {pointText(objectivePercent)}% / 主观 {pointText(100 - objectivePercent)}%。实际组成如上。正式生成会重新随机选题。</p>}</section>}
        </section><aside className="quiet-note"><Shuffle size={24} /><div><h3>每一题，只出现一次。</h3><p>{enabled ? '计分模式按总分与题型分值自动决定题量，支持调整客观与主观目标占比。' : '无分模式按指定题量随机抽取，提交后仍可核对正误与参考答案。'}</p><p>筛选条件不会被静默放宽。常见度为经验估计，请结合课程、考试或学习目标判断。</p></div></aside></div>}
    </fieldset></form>
  </>;
}

export function RandomFilters({ random, set }: { random: PaperFilters; set: <K extends keyof PaperFilters>(key: K, value: PaperFilters[K]) => void }) {
  const { bootstrap } = useApp();
  return <><div className="form-grid"><Field label="知识领域"><select value={random.domainId || ''} onChange={event => set('domainId', event.target.value)}><option value="">所有领域</option>{bootstrap.domains.map(domain => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></Field><Field label="分类（包括子类）"><select value={random.categoryId || ''} onChange={event => set('categoryId', event.target.value)}><option value="">所有分类</option><CategoryOptions categories={bootstrap.categories} domainId={random.domainId || undefined} /></select></Field></div><TagPicker tags={bootstrap.tags} domains={bootstrap.domains} domainIds={random.domainId ? [random.domainId] : undefined} values={random.tagIds || []} onChange={value => set('tagIds', value)} /><Field label="标签匹配方式"><select value={random.tagMode} onChange={event => set('tagMode', event.target.value as 'all' | 'any')}><option value="all">同时包含所有标签（AND）</option><option value="any">包含任一标签（OR）</option></select></Field><MultiSelect label="题型" options={Object.entries(typeLabels).map(([id, name]) => ({ id, name }))} values={random.types || []} onChange={value => set('types', value as QuestionType[])} /><div className="form-grid"><Field label="最低难度"><select value={random.difficultyMin} onChange={event => set('difficultyMin', Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>D{value}</option>)}</select></Field><Field label="最高难度"><select value={random.difficultyMax} onChange={event => set('difficultyMax', Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>D{value}</option>)}</select></Field><Field label="最低常见度"><select value={random.frequencyMin} onChange={event => set('frequencyMin', Number(event.target.value))}><option value="0">不限制（含未标常见度）</option><option value="1">F1 · 拓展及以上</option><option value="2">F2 · 较少见及常见</option><option value="3">F3 · 常见</option></select></Field><Field label="内容属性"><select value={random.collection} onChange={event => set('collection', event.target.value as PaperFilters['collection'])}><option value="all">通用 + 个人专项</option><option value="general">通用内容</option><option value="personal">个人专项</option></select></Field></div></>;
}

function SelectedQuestionPreview({id,title}:{id:string;title:string}){const[open,setOpen]=useState(false);const resource=useResource<Question>(open?`/api/questions/${idPath(id)}`:null);return <details className="selected-question-preview" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{title}</summary>{open&&(resource.loading?<Loading/>:resource.error?<ErrorNotice message={resource.error} retry={resource.refresh}/>:resource.data?<QuestionPreview question={resource.data}/>:null)}</details>;}
