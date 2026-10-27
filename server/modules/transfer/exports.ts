import {questionStemMarkdown} from '../../../shared/questions/blank-markers.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { typeLabels, type Question } from '../../../shared/models/types.js';
import { exportModeLabels, type ExportDocument, type ExportMode, type ExportQuestion } from '../../../shared/models/export-types.js';
import { attemptView, expandPaper, isCorrect, type StoredAttempt, type StoredPaper } from '../practice/service.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';
import type { StoredLeafQuestion } from '../questions/structure.js';
import { normalizeScoring } from '../practice/scoring.js';
import { Store, now } from '../../core/store.js';
import { fail, id, parse } from '../../core/validation.js';
import { extractContentNotices } from '../../../shared/questions/content-notices.js';
import { vocabularyPronunciationMarkdown } from '../../../shared/questions/vocabulary.js';

const labelValue = (value: string) => value === 'true' ? '正确' : value === 'false' ? '错误' : value;
const answerText = (value: string | string[] | undefined, type: Question['type']) => {
  const display = type === 'true_false' ? labelValue : (part: string) => part;
  return Array.isArray(value) ? value.map(display).join('、') || '（未作答）' : value ? display(value) : '（未作答）';
};
const plain = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
const points = (value: number) => `${Number(value.toFixed(2))}`;
export function exportFilename(title: string, mode: ExportMode) { return `${plain(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || '题集'}-${exportModeLabels[mode]}`; }

function questionDocument(question: StoredLeafQuestion, number: number, document: ExportDocument, attempt?: StoredAttempt): ExportQuestion {
  const q: ExportQuestion = { id: question.id, number, title: questionStemMarkdown({type:question.type,stemMarkdown:question.title}), type: question.type, stemMarkdown: questionStemMarkdown(question), options: question.type === 'true_false' ? [{ key: 'true', text: '正确' }, { key: 'false', text: '错误' }] : question.options, difficulty: question.difficulty, depth: question.depth, frequency: question.frequency, points: document.scoring.enabled ? document.scoring.questionPoints[question.id]! : null };
  Object.assign(q, { sourceQuestionId: question.sourceQuestionId || question.id, groupId: question.groupId, groupTitle: question.groupTitle, groupStemMarkdown: question.groupStemMarkdown, partId: question.partId, partIndex: question.partIndex, blanks: question.blanks?.map(({ answers: _answers, ...blank }) => blank) });
  if (document.mode === 'blank') return q;
  q.blanks = question.blanks;
  Object.assign(q, { answerMarkdown: [vocabularyPronunciationMarkdown(question.vocabulary), question.answerMarkdown].filter(Boolean).join('\n\n'), explanationMarkdown: question.explanationMarkdown, correctAnswers: question.correctAnswers, sourceRefs: question.sourceRefs });
  if (document.mode === 'completed' && attempt) {
    const answer = attempt.answers[question.id]; q.userAnswer = answer?.value ?? '';
    q.correct = isSubjectiveType(question.type) ? null : isCorrect(question, answer);
    if (!document.scoring.enabled) { q.grading = 'unscored'; q.earnedPoints = null; }
    else if (isSubjectiveType(question.type)) { q.earnedPoints = answer?.selfScore ?? null; q.grading = q.earnedPoints === null ? 'pending' : 'graded'; }
    else { q.earnedPoints = q.correct ? q.points : 0; q.grading = q.correct ? 'correct' : 'incorrect'; }
  }
  return q;
}

export function paperExportDocument(paper: StoredPaper, mode: 'blank' | 'answers'): ExportDocument {
  const expanded = expandPaper(paper);
  const document: ExportDocument = { version: 1, mode, title: paper.title, description: paper.description, filename: exportFilename(paper.title, mode), paperId: paper.id, paperVersion: paper.version, generatedAt: now(), snapshotCreatedAt: paper.updatedAt, scoring: expanded.scoring, questions: [], markdown: '' };
  document.questions = expanded.questions.map((q, index) => questionDocument(q, index + 1, document));
  document.markdown = exportMarkdown(document); return document;
}

export function attemptExportDocument(attempt: StoredAttempt, mode: ExportMode = 'completed'): ExportDocument {
  if (attempt.status !== 'submitted') fail(409, 'NOT_SUBMITTED', '请先交卷，再导出完成卷或本次练习的答案');
  const view = attemptView(attempt);
  const document: ExportDocument = { version: 1, mode, title: attempt.paperTitle, description: [attempt.vocabularyDirection === 'meaning_to_word' ? '词汇逆向练习：看释义想单词。' : attempt.vocabularyDirection === 'word_to_meaning' ? '词汇顺向练习：看单词想释义。' : '', '基于本次练习的历史题目、分值和作答快照导出。'].filter(Boolean).join(' '), filename: exportFilename(attempt.paperTitle, mode), paperId: attempt.paperId, paperVersion: attempt.paperVersion, attemptId: attempt.id, generatedAt: now(), snapshotCreatedAt: attempt.startedAt, submittedAt: attempt.submittedAt, scoring: view.scoring!, questions: [], markdown: '' };
  if (mode === 'completed') document.summary = { objectiveScore: view.objectiveScore, objectiveMax: view.objectiveMax, subjectiveScore: view.subjectiveScore, subjectiveMax: view.subjectiveMax, pendingSubjectiveCount: view.pendingSubjectiveCount ?? 0, totalScore: view.totalScore ?? null, correctObjectiveCount: attempt.questions.filter(q => !isSubjectiveType(q.type) && isCorrect(q, attempt.answers[q.id])).length, objectiveCount: attempt.questions.filter(q => !isSubjectiveType(q.type)).length };
  document.questions = attempt.questions.map((q, index) => questionDocument(q, index + 1, document, attempt));
  document.markdown = exportMarkdown(document); return document;
}

export function exportMarkdown(document: ExportDocument): string {
  const notices = new Map<string, {title:string;markdown:string;questions:Set<number>}>();
  const content = (markdown: string, number: number) => {
    const result = extractContentNotices(markdown);
    for (const notice of result.notices) {
      const key = JSON.stringify([notice.title, notice.markdown]);
      let entry = notices.get(key);
      if (!entry) { entry = {...notice, questions:new Set()}; notices.set(key, entry); }
      entry.questions.add(number);
    }
    return result.markdown;
  };
  const lines = [`# ${plain(document.title)}`, '', `**${exportModeLabels[document.mode]}** · v${document.paperVersion} · ${document.questions.length} 题`, '', document.description, '', document.scoring.enabled ? `卷面总分：${points(document.scoring.totalPoints)} 分` : '无分练习：不计算分数。', `导出时间：${document.generatedAt}`, `题目快照时间：${document.snapshotCreatedAt}`];
  if (document.mode === 'blank') lines.push('', '姓名：________________　日期：________________', '', '请在每题的答题区作答。');
  if (document.mode === 'completed' && document.summary) {
    const s = document.summary;
    lines.push(`提交时间：${document.submittedAt || '未记录'}`, '', `客观题正确：${s.correctObjectiveCount} / ${s.objectiveCount} 题`);
    if (document.scoring.enabled) lines.push(`客观题得分：${points(s.objectiveScore)} / ${points(s.objectiveMax)} 分`, `主观题已评得分：${points(s.subjectiveScore)} / ${points(s.subjectiveMax)} 分；待阅 ${s.pendingSubjectiveCount} 题`, s.totalScore === null ? '最终总分：待主观题阅卷完成后生成。' : `最终总分：${points(s.totalScore)} / ${points(document.scoring.totalPoints)} 分`);
    else lines.push('本次练习不计分；客观题显示正误，主观题对照参考答案复盘。');
  }
  for (const q of document.questions) {
    if (q.groupId && q.partIndex === 0) lines.push('', '---', '', `## 公共材料：${plain(q.groupTitle || '')}`, '', content(q.groupStemMarkdown || '',q.number), '');
    lines.push('', '---', '', `## ${q.number}. ${plain(q.title)}`, '', `${typeLabels[q.type]} · 难度 D${q.difficulty} · 深度 L${q.depth}${q.points !== null ? ` · 本题 ${points(q.points)} 分` : ''}`, '', content(q.stemMarkdown,q.number), '');
    for (const option of q.options) lines.push(`${q.type === 'true_false' ? '□' : `${option.key}.`} ${option.text}`, '');
    if (document.mode === 'blank') {
      lines.push('### 答题区', '', q.type === 'fill_blank' ? (q.blanks || []).map((b, i) => `${i + 1}. ${b.label}：________________`).join('\n\n') : isSubjectiveType(q.type) ? '________________________________________________________________\n\n________________________________________________________________\n\n________________________________________________________________\n\n________________________________________________________________' : '我的答案：________________', '');
      continue;
    }
    if (document.mode === 'completed') {
      lines.push('### 我的作答', '', answerText(q.userAnswer, q.type), '');
      if (!isSubjectiveType(q.type)) lines.push(`判定：${q.correct ? '正确' : '错误或未作答'}${q.points === null ? '（无分练习）' : `；得分 ${points(q.earnedPoints ?? 0)} / ${points(q.points)} 分`}`, '');
      else lines.push(q.points === null ? '阅卷：无分练习，请对照参考答案复盘。' : q.grading === 'pending' ? `阅卷：待阅（本题 ${points(q.points)} 分），当前不计入最终总分。` : `人工阅卷：${points(q.earnedPoints ?? 0)} / ${points(q.points)} 分`, '');
    }
    lines.push('### 参考答案', '');
    if (q.blanks?.length) lines.push(...q.blanks.map((b, i) => `${i + 1}. ${b.label}：${b.answers?.join(' / ') || ''}（${b.caseSensitive ? '区分' : '不区分'}大小写；${b.trim ? '忽略' : '保留'}首尾空白）`), '');
    if (q.correctAnswers?.length) lines.push(`正确选项：${q.correctAnswers.map(value => q.type === 'true_false' ? labelValue(value) : value).join('、')}`, '');
    lines.push(content(q.answerMarkdown || '（暂无参考答案）',q.number), '', '### 解析', '', content(q.explanationMarkdown || '（暂无补充解析）',q.number), '');
    if (q.sourceRefs?.length) lines.push('参考资料：', '', ...q.sourceRefs.map(ref => `- [${ref.label}](${ref.url})`), '');
  }
  if (notices.size) {
    lines.push('', '---', '', '## 学习说明与资料许可', '', '以下说明集中保留；相同条款仅列一次，题号对应本卷。', '');
    for (const notice of notices.values()) lines.push(`### ${notice.title}`, '', `适用题号：${[...notice.questions].join('、')}`, '', notice.markdown, '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** The same routes run in Fastify and the offline Android runtime. */
export function registerExportRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/papers/:id/export-document', async request => {
    const paperId = parse(id, (request.params as { id: string }).id);
    const query = parse(z.object({ mode: z.enum(['blank', 'answers']).default('blank') }).strict(), request.query);
    return paperExportDocument(store.require<StoredPaper>('papers', paperId), query.mode);
  });
  app.get('/api/attempts/:id/export-document', async request => {
    const attemptId = parse(id, (request.params as { id: string }).id);
    const query = parse(z.object({ mode: z.enum(['blank', 'answers', 'completed']).default('completed') }).strict(), request.query);
    return attemptExportDocument(store.require<StoredAttempt>('attempts', attemptId), query.mode);
  });
}
