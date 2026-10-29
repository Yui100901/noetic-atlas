import { ChevronDown, ChevronUp } from 'lucide-react';
import type { AiDocumentBlock, AiDocumentFailure } from '../../../shared/ai/ai-document';
import { typeLabels, type QuestionInput } from '../../../shared/models/types';
import { idPath } from '../../shared/lib/api';
import { ErrorNotice } from '../../shared/ui/components';

export interface AiDocumentPreviewEdit { json: string; selected: number[] }
import { QuestionContentPreview } from '../questions/question-content-preview';
function Failure({ value }: { value?: AiDocumentFailure }) {
  if (!value) return null;
  return <div className="ai-document-failure"><strong>{value.stage === 'plan' ? '总结失败' : '出题失败'}：{value.message}</strong><small>错误码 {value.code} · {value.retryable ? '可重试此批次' : '请先检查配置或资料条件'}</small>{value.auditId && <a className="button" href={`#/ai?tab=history&run=${idPath(value.auditId)}`}>查看具体失败记录</a>}</div>;
}

export function AiDocumentBlockCard({ block, checked, disabled, expanded, onToggle, onCheck, edit, onEdit, phaseLabels }: {
  block: AiDocumentBlock; checked: boolean; disabled: boolean; expanded: boolean; onToggle: () => void; onCheck: (checked: boolean) => void;
  edit?: AiDocumentPreviewEdit; onEdit: (value: AiDocumentPreviewEdit) => void; phaseLabels: Record<string, string>;
}) {
  const json = edit?.json ?? JSON.stringify(block.questions, null, 2);
  let questions: QuestionInput[] = [], parseError = '';
  if (expanded && block.questions.length) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.type !== 'string')) throw new Error('预览必须为题目对象数组，每题需要title和type。');
      questions = parsed as QuestionInput[];
    } catch (reason) { parseError = (reason as Error).message; }
  }
  const selected = edit?.selected ?? questions.map((_, index) => index);
  return <article className="ai-document-block" data-document-block={block.id}>
    <div className="ai-document-block-heading"><label className="check-row"><input type="checkbox" aria-label={`选择知识块 ${block.label}`} checked={checked} disabled={disabled} onChange={event => onCheck(event.target.checked)} /><strong>{block.title || block.label}</strong></label><button className="button" type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}知识块 ${block.label}`} onClick={onToggle}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}{expanded ? '收起' : '查看内容／预览'}</button></div>
    <p className="muted ai-document-source">{block.label} · {block.characters.toLocaleString()}字符</p>
    <div className="ai-document-statuses"><span className={`badge ai-run-status-${block.planStatus}`}>总结：{phaseLabels[block.planStatus]}</span><span className={`badge ai-run-status-${block.generationStatus}`}>出题：{phaseLabels[block.generationStatus]}</span><span className="muted">尝试{block.planAttempts}/{block.generationAttempts}次</span>{block.importedQuestionIds.length > 0 && <span className="badge ai-run-status-completed">已导入{block.importedQuestionIds.length}题</span>}</div>
    {block.summary && <p className="ai-document-summary">{block.summary}</p>}
    {block.topics.length > 0 && <div className="tags">{block.topics.map((topic, index) => <span className="tag" key={index}>{topic}</span>)}</div>}
    <Failure value={block.planFailure} /><Failure value={block.generationFailure} />
    {expanded && <div className="ai-document-block-body form-stack">
      {block.generationStatus === 'completed' && block.questions.length > 0 ? <>
        <p className="muted">本块生成{block.questions.length}题。可查看答案解析、修改JSON并取消不需要的题；确认导入后统一待审核。</p>
        {!block.importedQuestionIds.length && <details><summary>编辑本块完整题目 JSON</summary><textarea aria-label={`知识块 ${block.label} 题目JSON`} className="ai-preview-json" value={json} disabled={disabled} onChange={event => {
          let indexes = selected;
          try { const value: unknown = JSON.parse(event.target.value); if (Array.isArray(value)) indexes = value.map((_, index) => index); } catch { /* Preserve selection while typing incomplete JSON. */ }
          onEdit({ json: event.target.value, selected: indexes });
        }} spellCheck={false} /></details>}
        {parseError ? <ErrorNotice message={parseError} /> : <div className="ai-document-question-previews">{questions.map((question, index) => <details key={index}><summary>{!block.importedQuestionIds.length && <input type="checkbox" checked={selected.includes(index)} disabled={disabled} onClick={event => event.stopPropagation()} aria-label={`选中预览题 ${block.id} ${index + 1}`} onChange={event => onEdit({ json, selected: event.target.checked ? [...selected, index] : selected.filter(item => item !== index) })} />}<strong>{index + 1}. {question.title}</strong><small>{typeLabels[question.type] || question.type}</small></summary><div className="ai-document-question-body"><QuestionContentPreview question={question}/></div></details>)}</div>}
      </> : <p className="muted">{block.planStatus === 'completed' ? '已总结，勾选本块后可生成题目。' : '先运行AI总结，核对章节摘要和知识点后再选择出题。'}</p>}
    </div>}
  </article>;
}
