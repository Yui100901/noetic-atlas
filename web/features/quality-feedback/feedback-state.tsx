import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { QuestionFeedbackSummary } from '../../../shared/models/question-feedback';
import { request } from '../../shared/lib/api';

const changedEvent = 'atlas-question-feedback-changed';
export function notifyFeedbackChanged() { window.dispatchEvent(new Event(changedEvent)); }
export function useFeedbackSummaries(questionIds: string[]) {
  const key = JSON.stringify([...new Set(questionIds)].sort());
  const [summaries, setSummaries] = useState<Record<string, QuestionFeedbackSummary>>({}), [revision, setRevision] = useState(0);
  useEffect(() => { const update = () => setRevision(value => value + 1); window.addEventListener(changedEvent, update); return () => window.removeEventListener(changedEvent, update); }, []);
  useEffect(() => {
    const ids: string[] = JSON.parse(key), controller = new AbortController();
    setSummaries({});
    if (!ids.length) return () => controller.abort();
    void request<{ summaries: Record<string, QuestionFeedbackSummary> }>('/api/question-feedback/summaries', { method: 'POST', body: JSON.stringify({ questionIds: ids }), signal: controller.signal }).then(value => { if (!controller.signal.aborted && value?.summaries && typeof value.summaries === 'object') setSummaries(value.summaries); }).catch(() => { /* Missing quality metadata never breaks reading or asserts that content is verified. */ });
    return () => controller.abort();
  }, [key, revision]);
  return summaries;
}

const SummaryContext = createContext<Record<string, QuestionFeedbackSummary>>({});
export function FeedbackSummaryProvider({ questionIds, children }: { questionIds: string[]; children: ReactNode }) {
  const summaries = useFeedbackSummaries(questionIds); return <SummaryContext.Provider value={summaries}>{children}</SummaryContext.Provider>;
}
export function useFeedbackSummary(questionId: string) { return useContext(SummaryContext)[questionId]; }
