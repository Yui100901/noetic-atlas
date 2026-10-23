import { ShareButton } from '../sharing/sharing';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Edit3, FolderOpen, Plus, Trash2 } from 'lucide-react';
import type { QuestionBank, QuestionPage } from '../../../shared/models/types';
import { href, idPath, navigate, send, useDebounced, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Field, Loading, Modal, PageHeader, Pagination, SearchBox, SaveButton, useApp } from '../../shared/ui/components';
import { emptyFilters, FiltersPanel, questionQuery, QuestionRow, type Filters } from '../questions/questions';
import './question-banks.css';
import type { ListPage } from '../../shared/lib/pagination';

function BankEditor({ bank, onClose, onSaved }: { bank?: QuestionBank; onClose: () => void; onSaved: (bank: QuestionBank) => void }) {
  const [name, setName] = useState(bank?.name || ''); const [description, setDescription] = useState(bank?.description || '');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { onSaved(await send<QuestionBank>(bank ? `/api/question-banks/${idPath(bank.id)}` : '/api/question-banks', bank ? 'PUT' : 'POST', { name: name.trim(), description, questionIds: bank?.questionIds || [], ...(bank ? { updatedAt: bank.updatedAt } : {}) })); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <Modal title={bank ? '编辑题库集合' : '新建题库集合'} onClose={onClose}><form className="form-stack" onSubmit={submit}>{error && <ErrorNotice message={error} />}<Field label="集合名称"><input required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="例如：英语词汇 / 本月复习" /></Field><Field label="用途说明"><textarea rows={4} maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} placeholder="可以按领域、考试、学习阶段或个人目标组织。" /></Field><p className="muted">题库集合只保存引用。同一道题可以加入多个集合，题目的分类与学习记录共用。</p><SaveButton busy={busy}>保存题库集合</SaveButton></form></Modal>;
}

export function QuestionBanksPage() {
  const [search,setSearch]=useState(''),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(20); const resource = useResource<ListPage<QuestionBank>>(`/api/question-banks?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(useDebounced(search))}`); const { toast } = useApp(); const [creating, setCreating] = useState(false);
  return <><PageHeader eyebrow="QUESTION COLLECTIONS" title="为不同目标，整理自己的题库。" description="集合保存题目引用，可以按领域管理，也可以跨领域组合；同一道题可以出现在多个集合中。" actions={<><a className="button" href="#/questions">浏览所有题目</a><button className="button primary" onClick={() => setCreating(true)}><Plus size={16} />新建题库集合</button></>} />
    <div className="notice info bank-relationship-note"><FolderOpen size={20} /><p>领域与分类描述题目的知识归属，标签连接主题与学习方式；题库集合整理你想一起学习的题目。通用内容 / 个人专项仍是内容属性。</p></div>
    <SearchBox value={search} onChange={value=>{setSearch(value);setPage(1);}} placeholder="搜索题库集合"/>{resource.loading ? <Loading /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : resource.data?.items.length ? <><div className="question-bank-grid">{resource.data.items.map(bank => <section className="card bank-card" key={bank.id}><FolderOpen size={23} /><h2><a href={href('banks', bank.id)}>{bank.name}</a></h2><p className="bank-description">{bank.description || '为这个集合添加题目，建立自己的学习范围。'}</p><div className="bank-counts"><span>{bank.questionIds.length} 道题目引用</span><span>允许跨领域</span></div><div className="bank-actions"><a className="button primary" href={href('banks', bank.id)}>进入集合</a><a className="button" href={`#/banks/${idPath(bank.id)}/manage`}>管理题目</a></div></section>)}</div><Pagination page={page} pageSize={pageSize} total={resource.data.total} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label="题库集合"/></> : <Empty title="创建第一个题库集合" description="例如后端高频、AI应用、英语学习，或跨领域的本月复习。原有题目都可从“知识题库”访问。" actions={<button className="button primary" onClick={() => setCreating(true)}>新建题库集合</button>} />}
    {creating && <BankEditor onClose={() => setCreating(false)} onSaved={bank => { setCreating(false); toast('题库集合已创建'); navigate('banks', bank.id); }} />}
  </>;
}

export function QuestionBankDetail({ id }: { id: string }) {
  const bank = useResource<QuestionBank>(`/api/question-banks/${idPath(id)}`); const { toast } = useApp();
  const [editing, setEditing] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters, bankId: id }); const [page, setPage] = useState(1); const [pageSize,setPageSize]=useState(20); const debounced = useDebounced(filters);
  const questions = useResource<QuestionPage>(questionQuery({ ...debounced, bankId: id }, page,pageSize));
  const remove = async () => {
    if (!bank.data || !confirm(`删除题库集合「${bank.data.name}」？只移除该集合，不删除题目或学习记录。`)) return;
    setBusy(true); setError(''); try { await send(`/api/question-banks/${idPath(id)}`, 'DELETE'); toast('集合已删除，原题保留'); navigate('banks'); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (bank.loading) return <Loading />; if (bank.error || !bank.data) return <ErrorNotice message={bank.error || '题库集合不存在'} retry={bank.refresh} />;
  return <><a className="back-link" href="#/banks"><ArrowLeft size={15} />返回题库集合</a><PageHeader eyebrow="QUESTION COLLECTION" title={bank.data.name} description={bank.data.description || '这个集合通过引用组织题目。'} actions={<><ShareButton kind="bank" id={id} /><button className="button" onClick={() => setEditing(true)}><Edit3 size={15} />编辑集合</button><a className="button primary" href={`#/banks/${idPath(id)}/manage`}><Plus size={15} />添加 / 移除题目</a><button className="button danger-text" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />删除集合</button></>} />
    <div className="card bank-actions"><span>共 {bank.data.questionIds.length} 道题目引用；默认仅展示已发布题目。</span><a className="button" href={`#/questions/import?bankId=${idPath(id)}`}>批量新增到此集合</a><a className="button" href={`#/papers/new/random?bankId=${idPath(id)}`}>从此集合随机组卷</a></div>
    {error && <ErrorNotice message={error} />}<FiltersPanel filters={filters} onChange={value => { setFilters({ ...value, bankId: id }); setPage(1); }} hideBank />
    <div className="result-heading"><span>{questions.loading ? '正在筛选…' : `当前条件下 ${questions.data?.total || 0} 题`}</span><span className="muted">未发布题不能用于组卷</span></div>
    {questions.loading ? <Loading /> : questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : questions.data?.items.length ? <><div className="question-list">{questions.data.items.map(q => <QuestionRow key={q.id} question={q} />)}</div><Pagination page={page} pageSize={pageSize} onPageSize={size=>{setPageSize(size);setPage(1);}} total={questions.data.total} onPage={setPage} /></> : <Empty title="当前没有符合条件的题目" description="可以管理集合成员，或在筛选中查看待审核题与其他状态。" />}
    {editing && <BankEditor bank={bank.data} onClose={() => setEditing(false)} onSaved={saved => { bank.setData(saved); setEditing(false); toast('集合已更新'); }} />}
  </>;
}

export function QuestionBankMembers({ id }: { id: string }) {
  const bank = useResource<QuestionBank>(`/api/question-banks/${idPath(id)}`); const { toast } = useApp();
  const [ids, setIds] = useState<string[]>([]); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters, status: 'all' }); const [page, setPage] = useState(1); const [pageSize,setPageSize]=useState(20); const [onlyMembers, setOnlyMembers] = useState(false);
  const debounced = useDebounced(filters); const questions = useResource<QuestionPage>(questionQuery({ ...debounced, bankId: onlyMembers ? id : '' }, page,pageSize));
  useEffect(() => { if (bank.data) setIds(bank.data.questionIds); }, [bank.data]);
  const toggle = (qid: string) => setIds(old => old.includes(qid) ? old.filter(value => value !== qid) : [...old, qid]);
  const save = async () => {
    if (!bank.data) return; setBusy(true); setError('');
    try { await send(`/api/question-banks/${idPath(id)}`, 'PUT', { name: bank.data.name, description: bank.data.description, questionIds: ids, updatedAt: bank.data.updatedAt }); toast('题库引用已保存'); navigate('banks', id); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  if (bank.loading) return <Loading />; if (bank.error || !bank.data) return <ErrorNotice message={bank.error || '集合不存在'} retry={bank.refresh} />;
  const changed = ids.length !== bank.data.questionIds.length || ids.some(qid => !bank.data!.questionIds.includes(qid));
  return <><a className="back-link" href={href('banks', id)}><ArrowLeft size={15} />返回集合</a><PageHeader eyebrow="MANAGE REFERENCES" title={`整理「${bank.data.name}」`} description="勾选以引用题目，取消勾选以移出集合。待审核、草稿与归档题可保留引用，正式组卷只抽取已发布题。" />
    <div className="card bank-actions"><label><input type="checkbox" checked={onlyMembers} onChange={e => { setOnlyMembers(e.target.checked); setPage(1); }} /> 只看当前已保存的集合成员</label><span className="muted">选择跨页保留，点击保存后生效。</span></div>
    <FiltersPanel filters={filters} onChange={value => { setFilters(value); setPage(1); }} hideBank />{error && <ErrorNotice message={error} />}
    {questions.loading ? <Loading /> : questions.error ? <ErrorNotice message={questions.error} retry={questions.refresh} /> : questions.data?.items.length ? <><div className="bank-picker-list">{questions.data.items.map(q => <div className="bank-membership-row" key={q.id}><input type="checkbox" aria-label={`集合引用 ${q.id}`} checked={ids.includes(q.id)} disabled={busy} onChange={() => toggle(q.id)} /><QuestionRow question={q} /></div>)}</div><Pagination page={page} pageSize={pageSize} onPageSize={size=>{setPageSize(size);setPage(1);}} total={questions.data.total} onPage={setPage} /></> : <Empty title="没有符合条件的题目" />}
    <div className="bank-picker-toolbar"><div><strong>已选 {ids.length} 道引用</strong><span className="muted">{changed ? ' · 有未保存修改' : ' · 与已保存集合一致'}</span></div><div className="bank-actions"><button className="button" disabled={busy} onClick={() => setIds(bank.data!.questionIds)}>撤销修改</button><button className="button primary" disabled={busy || !changed} onClick={() => void save()}><Check size={16} />{busy ? '正在保存…' : '保存集合引用'}</button></div></div>
  </>;
}
