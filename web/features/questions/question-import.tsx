import { useState, type ChangeEvent } from 'react';
import { ArrowLeft, Check, Download, Upload } from 'lucide-react';
import type { QuestionInput } from '../../../shared/models/types';
import { request, send } from '../../shared/lib/api';
import { ErrorNotice, PageHeader, Pagination, useApp } from '../../shared/ui/components';
import { saveGeneratedFile } from '@platform';
import './question-import.css';
import { usePagination } from '../../shared/lib/pagination';

interface NewQuestionFile { format: 'learning-new-questions'; schemaVersion: 1; questions: QuestionInput[] }
export function QuestionImportPage() {
  const { bootstrap, reload, toast } = useApp();
  const [incoming, setIncoming] = useState<NewQuestionFile | null>(null);
  const [fileName, setFileName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const previewPaging=usePagination(incoming?.questions||[],fileName);
  const [result, setResult] = useState<{ added: number } | null>(null);
  const saveJson = (name: string, value: unknown) => saveGeneratedFile(name, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), 'application/json');
  const template = async () => {
    setBusy(true); setError('');
    try { await saveJson('认知星图-批量新增题目模板.json', await request('/api/questions/import-template')); toast('新增题目模板已生成，可保存或分享'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const taxonomy = async () => {
    setBusy(true); setError('');
    try { await saveJson('认知星图-分类标签ID参考.json', { usage: '仅供填写模板的 categoryIds / tagIds 参考，不是题目导入文件。请先在分类与标签页建立新领域和标签。', domains: bootstrap.domains, categories: bootstrap.categories, tags: bootstrap.tags }); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; setIncoming(null); setFileName(''); setResult(null); setError(''); if (!file) return;
    try {
      if (file.size > 75 * 1024 * 1024) throw new Error('文件超过75 MiB，请拆成多个批次。');
      const data = JSON.parse(await file.text());
      if (data?.format !== 'learning-new-questions' || data?.schemaVersion !== 1 || !Array.isArray(data.questions) || !data.questions.length || data.questions.length > 500) throw new Error('请选择新增题目模板格式的 JSON，单批1—500题。备份迁移和待审核修改请使用各自入口。');
      if (data.questions.some((q: QuestionInput) => !q || typeof q !== 'object' || typeof q.title !== 'string' || !q.title.trim())) throw new Error('每道题必须是带有非空 title 的对象。完整字段与引用会在提交时统一校验。');
      setIncoming(data); setFileName(file.name);
    } catch (err) { setError((err as Error).message); }
  };
  const submit = async () => {
    if (!incoming || !confirm(`确认新增 ${incoming.questions.length} 道题？它们全部进入待审核，审核通过后才能用于练习。任何一题校验失败都会整批回滚。`)) return;
    setBusy(true); setError('');
    try {
      const imported = await send<{ added: number }>('/api/questions/bulk-import', 'POST', { data: incoming, confirmed: true });
      setResult(imported); setIncoming(null); toast(`已新增 ${imported.added} 道待审核题`); reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return <><a className="back-link" href="#/questions"><ArrowLeft size={15} />返回知识题库</a>
    <PageHeader eyebrow="BULK QUESTION IMPORT" title="批量收集，逐步核对。" description="把整理好的新题按模板导入。每道新题都进入待审核，通过审核后再加入正式题库。" actions={<a className="button" href="#/ai">AI辅助转换 PDF / 文本</a>} />
    <div className="import-purpose-grid"><section className="card"><strong>批量新增</strong><p>本页接收全新的题目。无论文件原状态是什么，导入后均为待审核，不覆盖已有题号。</p></section><a className="card" href="#/questions/review"><strong>修改待审核题 →</strong><p>在审核页导出、修改再回导，保留题号和版本；用于批量修正已有待审核内容。</p></a><a className="card" href="#/data"><strong>备份与题库迁移 →</strong><p>迁移可信备份，保留发布和审核状态、题集、学习记录及作答历史。</p></a></div>
    <div className="ui-stack"><section className="card form-stack"><h2>1. 下载模板并整理题目</h2><div className="action-row"><button className="button primary" disabled={busy} onClick={() => void template()}><Download size={16} />下载 JSON 新题模板</button><button className="button" disabled={busy} onClick={() => void taxonomy()}><Download size={16} />下载分类与标签 ID</button><a className="button" href="#/taxonomy">管理分类与标签</a></div>
      <p className="muted">模板包含判断、单选、多选、填空、简答、论述及组合题示例。可删除示例后填入自己的题目；示例本身也会被当作新题导入。</p>
      <details className="import-field-help"><summary>查看字段与格式说明</summary><div className="table-scroll"><table><thead><tr><th>字段</th><th>填写方式</th></tr></thead><tbody>
        <tr><td>format / schemaVersion / questions</td><td>保留模板外层结构。questions 为题目数组，单批最多500题。</td></tr>
        <tr><td>id</td><td>可省略，由系统生成；填写时必须为尚未存在的唯一题号，冲突将整批拒绝。</td></tr>
        <tr><td>type</td><td>true_false（判断）、single_choice（单选）、multiple_choice（多选）、fill_blank（填空）、short_answer（简答）、essay（论述/写作）；group表示带公共材料的组合题结构。</td></tr>
        <tr><td>title / stemMarkdown</td><td>题目名称与题干；题干可用 Markdown 编写代码、表格等。</td></tr>
        <tr><td>answerMarkdown / explanationMarkdown</td><td>参考答案与解释、追问、误区。</td></tr>
        <tr><td>options / correctAnswers</td><td>客观题参照模板填写；判断答案为 ["true"] 或 ["false"]；选择题使用选项 key。</td></tr>
        <tr><td>blanks / parts</td><td>填空的 blanks 按顺序填写提示、可接受答案和匹配规则；组合题 parts 填写独立小题及分值权重，不嵌套组合题。</td></tr><tr><td>categoryIds / tagIds</td><td>填写系统中已有 ID，可先留 []。领域主题标签必须匹配题目分类的领域。</td></tr>
        <tr><td>difficulty / depth / frequency</td><td>难度 D1—D4、深度 L1—L4、常见度 F0—F3；0表示未标常见度。</td></tr>
        <tr><td>collection / status</td><td>collection 为 general（通用内容）或 personal（个人专项）。批量新增的 status 一律变为 pending。</td></tr>
      </tbody></table></div></details>
    </section>
    <section className="card form-stack"><h2>2. 上传新题 JSON</h2>
      <label className="button pending-file-picker"><Upload size={16} />选择新增题目 JSON<input aria-label="新增题目 JSON 文件" type="file" accept=".json,application/json" disabled={busy} onChange={e => void load(e)} /></label>
      {error && <ErrorNotice message={error} />}{incoming && <div className="pending-import-preview"><strong>{fileName} · 共 {incoming.questions.length} 道新题</strong><ul>{previewPaging.items.map((q, i) => <li key={i}>{q.id ? `${q.id} · ` : ''}{q.title}</li>)}</ul><Pagination {...previewPaging} label="导入题目预览"/><p>源文件中的审核状态不适用于新增操作，全部转为待审核。校验失败时不会部分导入。</p><div className="action-row"><button className="button primary" disabled={busy} onClick={() => void submit()}><Check size={16} />{busy ? '正在校验并新增…' : '确认导入到待审核'}</button><button className="button" disabled={busy} onClick={() => setIncoming(null)}>取消</button></div></div>}
      {result && <div className="notice success" role="status"><Check size={18} /><div>已新增 {result.added} 道待审核题。<div className="action-row"><a href="#/questions/review">前往审核</a></div></div></div>}
    </section></div>
  </>;
}
