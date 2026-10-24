import { useState } from 'react';
import { ChevronDown, History, RefreshCw } from 'lucide-react';
import type { AttemptAnswer } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import type { LearningQuestionSnapshot } from '../../../shared/practice/context-learning';
import { href, idPath, localDate, qs, useResource } from '../../shared/lib/api';
import { pointText } from '../../shared/lib/scoring';
import { ErrorNotice, Loading, Pagination } from '../../shared/ui/components';
import { QuestionContent, SourceNoticeScope, questionNoticeContents } from '../../shared/ui/content-notices';
import { BlankAnswerSummary } from './question-structure';
import './question-history.css';

type Verdict = 'correct' | 'partial' | 'incorrect' | 'ungraded';
interface QuestionHistoryItem {
  id: string; attemptId: string; source: 'paper' | 'quick';
  paperId: string; paperTitle: string; paperVersion: number; submittedAt: string;
  historyAvailable: boolean; beforeReset?: boolean;
  question: LearningQuestionSnapshot; answer: AttemptAnswer; verdict: Verdict;
  points: number | null; score: number | null;
}
interface QuestionHistoryPage {
  summary: { answered: number; correct: number; partial: number; incorrect: number; ungraded: number; lastAnsweredAt: string | null; unknown?: number };
  retention: { limit: number; available: number };
  items: QuestionHistoryItem[]; total: number; page: number; pageSize: number;
}
interface QuestionHistoryProps {
  questionId: string; partId?: string; aggregate?: boolean; beforeOpenReview?: () => boolean;
}
const verdictLabels: Record<Verdict, string> = { correct: '正确', partial: '部分正确', incorrect: '错误', ungraded: '未判' };
const answerText = (value: string, question: LearningQuestionSnapshot) => question.type === 'true_false' ? value === 'true' ? '对 / 正确' : value === 'false' ? '错 / 错误' : value : value;

/** Keep each original question/part's paging and disclosure state independent. */
export function QuestionHistory(props: QuestionHistoryProps) {
  return <QuestionHistoryContent key={`${props.questionId}:${props.partId ?? 'whole'}`} {...props} />;
}

function QuestionHistoryContent({ questionId, partId, aggregate = false, beforeOpenReview }: QuestionHistoryProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const resource = useResource<QuestionHistoryPage>(open ? `/api/questions/${idPath(questionId)}/history?${qs({ partId, page, pageSize: 10 })}` : null);
  const data = resource.data;
  const title = aggregate ? '整组作答统计与历史 · 小题合计' : partId !== undefined ? '本小题的作答统计与历史' : '本题的作答统计与历史';
  return <section className="card question-history">
    <button type="button" className="question-history-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><span><History size={18} />{title}</span><ChevronDown size={17} className={open ? 'rotated' : ''} /></button>
    {!open && <p className="muted question-history-intro">跨题集与随机自测，查看实际提交的作答次数和完整答案。</p>}
    {open && <div className="question-history-body">
      <p className="muted">{aggregate ? '每道小题分别计次，再合计展示。' : '仅统计本题实际填写并已提交的作答。'}漏答、未提交草稿、查看解析和掌握自评不计作答次数。</p>
      {resource.loading ? <Loading text="正在读取本题作答记录…" /> : resource.error ? <ErrorNotice message={resource.error} retry={resource.refresh} /> : data && <>
        <dl className="question-history-stats" aria-label="实际作答统计">
          <div><dt>实际作答</dt><dd>{data.summary.answered.toLocaleString()}<small> 次</small></dd></div>
          {(['correct', 'incorrect', 'partial', 'ungraded'] as const).map(verdict => <div key={verdict} className={`question-history-stat-${verdict}`}><dt>{verdictLabels[verdict]}</dt><dd>{data.summary[verdict].toLocaleString()}</dd></div>)}
        </dl>
        <div className="question-history-status"><p className="muted">最近作答：{localDate(data.summary.lastAnsweredAt)}</p><button type="button" className="text-button" onClick={resource.refresh}><RefreshCw size={13} />刷新记录</button></div>
        {!!data.summary.unknown && <p className="notice info">有 {data.summary.unknown} 条旧记录缺少实际填写信息，未纳入以上统计。</p>}
        <p className="muted question-history-retention">{data.retention.limit === 0 ? '已关闭单题详细历史；累计统计继续保留，整卷记录按各自配置保留。' : `${aggregate ? '各小题分别' : '本题'}保留最近 ${data.retention.limit} 次实际填写并提交的完整作答，跨题集和随机自测合并计算。当前可查 ${data.retention.available} 条。`} 详细历史上限可在系统配置中调整；整卷历史默认不限量。清理详细记录不减少累计统计。</p>
        {!!data.items.length && <div className="question-history-items">{data.items.map(item => <QuestionHistoryRecord key={item.id} item={item} beforeOpenReview={beforeOpenReview} />)}</div>}
        {!data.items.length && <p className="question-history-empty">{data.retention.limit === 0 ? '当前未保留单题详细记录。' : '暂无可查看的已提交作答。完成一次实际作答并提交后，会显示在这里。'}</p>}
        {data.total > data.pageSize && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} label="单题作答历史" />}
      </>}
    </div>}
  </section>;
}

function QuestionHistoryRecord({ item, beforeOpenReview }: { item: QuestionHistoryItem; beforeOpenReview?: () => boolean }) {
  const [open, setOpen] = useState(false);
  const question = item.question;
  const source = item.source === 'quick' ? '随机 / 单题自测' : `${item.paperTitle} · v${item.paperVersion}`;
  const score = item.points == null ? '无分练习' : item.score == null ? `待判分 / ${pointText(item.points)} 分` : `${pointText(item.score)} / ${pointText(item.points)} 分`;
  const values = Array.isArray(item.answer.value) ? item.answer.value : [item.answer.value];
  return <details className="question-history-record" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className={`question-history-verdict verdict-${item.verdict}`}>{verdictLabels[item.verdict]}</span><span className="question-history-record-info"><time dateTime={item.submittedAt}>{localDate(item.submittedAt)}</time><span>{source}</span></span><span className="question-history-score">{score}</span><ChevronDown size={15} className={open ? 'rotated' : ''} /></summary>
    {open && <div className="question-history-record-body">
      {item.beforeReset && <p className="notice info">重置前记录，不计当前统计。</p>}
      <SourceNoticeScope contents={questionNoticeContents(question)}>
        <div className="question-history-snapshot-heading"><span className="section-label">本次提交时的题目快照</span><span className="badge">{typeLabels[question.type]}</span></div>
        <h3>{question.title}</h3>
        {question.groupStemMarkdown && <section className="group-material"><span className="section-label">公共材料{question.groupTitle ? ` · ${question.groupTitle}` : ''}</span><QuestionContent>{question.groupStemMarkdown}</QuestionContent></section>}
        <QuestionContent>{question.stemMarkdown}</QuestionContent>
        {!!question.options.length && <div className="read-options">{question.options.map(option => <div key={option.key}><strong>{option.key}</strong><QuestionContent>{option.text}</QuestionContent></div>)}</div>}
        <section className="question-history-user-answer"><h4>我的作答</h4>{question.type === 'fill_blank' && Array.isArray(item.answer.value) ? <ol>{values.map((value, index) => <li key={index}><span className="muted">{question.blanks?.[index]?.label || `第${index + 1}空`}：</span><span className="question-history-answer-text">{value || '（此空未填写）'}</span></li>)}</ol> : <div className="question-history-answer-text">{values.map(value => answerText(value, question)).join('、')}</div>}<p className="muted">判定：{verdictLabels[item.verdict]} · {score}{item.answer.mastery != null ? ` · 掌握自评 ${item.answer.mastery}/3` : ''}</p></section>
        <section className="question-history-reference"><h4>当时的参考答案{question.correctAnswers.length ? ` · ${question.correctAnswers.map(value => answerText(value, question)).join('、')}` : ''}</h4><BlankAnswerSummary blanks={question.blanks} /><QuestionContent>{question.answerMarkdown}</QuestionContent>{question.explanationMarkdown && <><h4>当时的解析</h4><QuestionContent>{question.explanationMarkdown}</QuestionContent></>}</section>
      </SourceNoticeScope>
      <div className="question-history-record-footer"><span className="muted">来源：{source} · 提交于 {localDate(item.submittedAt)}</span>{item.historyAvailable ? <a className="text-button" data-question-history-review="true" href={href('attempts', item.attemptId)} onClick={event => { if (beforeOpenReview?.() === false) event.preventDefault(); }}>打开整卷复盘 →</a> : <span className="muted">整卷历史已清理，本题完整作答仍保留。</span>}</div>
    </div>}
  </details>;
}
