import type { MouseEvent } from 'react';
import type { GlobalLearningKind, GlobalLearningQuestion, LearningOrigin } from '../../../shared/practice/global-learning';
import { href, idPath, localDate } from '../../shared/lib/api';
import { vocabularyDirectionLabel } from '../papers/vocabulary-practice';

function originTitle(origin: LearningOrigin) {
  const title = origin.source === 'library' ? '知识题库' : origin.source === 'quick' ? '随机与单题自测' : origin.paperTitle;
  return title + (origin.vocabularyDirection ? ` · ${vocabularyDirectionLabel(origin.vocabularyDirection)}` : '');
}

export function snapshotDescription(item: GlobalLearningQuestion) {
  if (item.snapshotSource === 'library') return '展示当前原题内容；学习状态与知识题库共享。';
  const origin = item.origins.find(value => value.attemptId === item.attemptId);
  return `展示最近错误快照：${origin ? originTitle(origin) : '已保存作答'}${origin?.paperVersion != null && origin.source === 'paper' ? ` · v${origin.paperVersion}` : ''} · ${localDate(origin?.submittedAt || origin?.startedAt || item.lastPracticedAt)}${item.attemptId ? ` · 答题 ${item.attemptId}` : ''}。`;
}

/** Preserve all provenance, including separate current membership and attempts. */
export function LearningOrigins({ item, kind, onNavigate }: { item: GlobalLearningQuestion; kind: GlobalLearningKind; onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  const primary = item.origins.find(origin => origin.attemptId === item.attemptId) || item.origins[0];
  return <details className="learning-origins"><summary>{kind === 'wrong' ? '错题产生于' : '关联来源'} · {primary ? originTitle(primary) : '知识题库'}{item.origins.length > 1 ? ` · 共 ${item.origins.length} 项，展开全部来源` : ' · 展开来源详情'}</summary>
    {kind !== 'wrong' && <p className="learning-origin-note">列出当前题集成员关系与相关作答；关联关系不代表收藏或复习操作发生在这些题集中。</p>}
    <ul>{item.origins.map((origin, index) => <li key={`${origin.source}:${origin.paperId || ''}:${origin.attemptId || 'membership'}:${index}`}>
      <div className="learning-origin-title">{origin.source === 'paper' && origin.paperId ? <a href={`#/papers/${idPath(origin.paperId)}${origin.deleted ? '/activity' : ''}?tab=${kind === 'wrong' ? 'wrong' : kind === 'favorite' ? 'favorite' : 'review'}`} onClick={onNavigate}>{origin.paperTitle}</a> : origin.source === 'quick' ? <a href={`#/quick?tab=${kind === 'wrong' ? 'wrong' : kind === 'favorite' ? 'favorite' : 'review'}`} onClick={onNavigate}>随机与单题自测</a> : <span>知识题库 · 直接收藏 / 复习入口</span>}
        {origin.deleted && <span className="badge status-muted">题集已删除 · 历史保留</span>}{origin.archived && <span className="badge status-muted">题集已归档</span>}{origin.paperVersion != null && <span className="badge">v{origin.paperVersion}</span>}{origin.vocabularyDirection && <span className="badge">{vocabularyDirectionLabel(origin.vocabularyDirection)}</span>}
      </div>
      {origin.attemptId ? <p>{origin.historyAvailable === false ? <span>原答题历史已清理 · {origin.attemptId} · 错题与来源保留</span> : <a href={href('attempts', origin.attemptId)} onClick={onNavigate}>查看这次答题 · {origin.attemptId}</a>}<span> · {localDate(origin.submittedAt || origin.startedAt)}</span>{origin.answerState && <span> · {origin.answerState === 'unanswered' ? '客观题漏答' : '回答错误'}</span>}{kind === 'wrong' && origin.wrongCount != null && <span> · 本来源累计错误 {origin.wrongCount} 次</span>}{item.snapshotSource === 'attempt' && origin.attemptId === item.attemptId && <strong> · 当前展示的快照</strong>}</p> : <p>{origin.source === 'library' ? '当前没有关联题集或作答，学习记录直接归属知识题库原题。' : '当前题集包含此题，可进入题集继续学习。'}</p>}
    </li>)}</ul>
    {kind === 'wrong' && <p className="learning-origin-note">同一道题在不同来源合并展示。当前阅读最近一次错误快照；整卷历史清理后仍保留错误题目和来源摘要。</p>}
  </details>;
}
