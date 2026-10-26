import { useRef } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import type { PaperDetail } from '../../../shared/models/types';
import { idPath, useResource } from '../../shared/lib/api';
import { useNavigationGuard } from '../../shared/lib/navigation-guard';
import { Empty, ErrorNotice, Loading, PageHeader, useApp } from '../../shared/ui/components';
import { QuestionSetQuestionViewer, type QuestionViewerHandle } from '../questions/question-viewer';
import { paperContentsHref, paperQuestionHref, type PaperContentsContext } from './reader-navigation';
import './paper-question.css';

export function PaperQuestionPage({ paperId, questionId, context }: { paperId: string; questionId: string; context: PaperContentsContext }) {
  const paper = useResource<PaperDetail>(`/api/papers/${idPath(paperId)}?summary=true`);
  const viewer = useRef<QuestionViewerHandle>(null);
  const { toast } = useApp();
  useNavigationGuard({
    pending: () => viewer.current?.hasUnsavedChanges() || false,
    saving: () => viewer.current?.isSaving() || false,
    confirmLeave: () => viewer.current?.confirmLeave() !== false,
    onBusy: () => toast('学习记录正在保存，请稍后再离开。', true),
  });
  const back = paperContentsHref(paperId, context);
  const index = paper.data?.questions.findIndex(question => question.id === questionId) ?? -1;
  const selected = index >= 0 ? paper.data!.questions[index] : undefined;
  const previous = index > 0 ? paper.data!.questions[index - 1] : undefined;
  const next = index >= 0 ? paper.data!.questions[index + 1] : undefined;
  return <article className="paper-question-page">
    <a className="back-link" href={back}><ArrowLeft size={15} />返回题集{paper.data ? ` · ${paper.data.title}` : ''}</a>
    {paper.loading ? <Loading text="正在读取题集…" /> : paper.error || !paper.data ? <><ErrorNotice message={paper.error || '题集不存在'} retry={paper.refresh} /><a className="button" href="#/papers">返回题集列表</a></> : !selected ? <Empty title="该题目不在当前题集中" description="题集内容可能已调整，请返回题集重新选择。" actions={<a className="button primary" href={back}>查看题集内容</a>} /> : <>
      <PageHeader eyebrow={`题集阅读 · V${paper.data.version}`} title={selected.title} description={paper.data.title} actions={
        <nav className="paper-reader-navigation" aria-label="题集阅读导航">
          <a role="link" className="button" href={previous ? paperQuestionHref(paperId, previous.id, context) : undefined} aria-disabled={!previous} tabIndex={previous ? undefined : -1}><ChevronLeft size={16} />上一题</a>
          <span role="status">第 {index + 1} / {paper.data.questions.length} 题</span>
          <a role="link" className="button" href={next ? paperQuestionHref(paperId, next.id, context) : undefined} aria-disabled={!next} tabIndex={next ? undefined : -1}>下一题<ChevronRight size={16} /></a>
        </nav>
      } />
      <p className="paper-reader-context muted">按本题集的顺序阅读；返回后保留原列表的搜索与分页。{paper.data.archived && ' 题集已归档，仍可阅读保存的内容。'}</p>
      <QuestionSetQuestionViewer key={`${paperId}:${questionId}`} ref={viewer} paperId={paperId} questionId={questionId} presentation="page" />
    </>}
  </article>;
}
