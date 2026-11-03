import { useEffect, useState } from 'react';
import type { VocabularyData } from '../../../shared/models/types';
import { request, useDebounced } from '../../shared/lib/api';

interface Matches {
  total: number;
  items: Array<{ id: string; headword: string; title: string }>;
}

/** Advisory only: equal hints are ambiguity candidates, never synonym proof.
 * Keyed results and cancellation prevent a late response describing a new hint. */
export function VocabularyPromptMatches({
  value,
  questionId,
}: {
  value: VocabularyData;
  questionId?: string;
}) {
  const active = value.reverseEnabled !== false && !!value.meaningPrompt.trim();
  const key = active
    ? JSON.stringify({
        language: value.language,
        prompt: value.meaningPrompt.normalize('NFC').trim(),
        ...(questionId ? { excludeId: questionId } : {}),
      })
    : '';
  const debounced = useDebounced(key, 350);
  const [result, setResult] = useState<{ key: string; data?: Matches; error?: string } | null>(
    null,
  );
  useEffect(() => {
    if (!debounced || debounced !== key) return;
    const controller = new AbortController();
    void request<Matches>('/api/vocabulary/prompt-matches', {
      method: 'POST',
      body: debounced,
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key: debounced, data });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({ key: debounced, error: String(error.message || error) });
      });
    return () => controller.abort();
  }, [debounced, key]);
  if (!key || result?.key !== key) return null;
  if (result.error)
    return (
      <p className="muted" role="status">
        暂未完成独立提示重复检查，可继续编辑或稍后重新核对。
      </p>
    );
  if (!result.data?.total) return null;
  return (
    <div
      className="notice info vocabulary-prompt-matches"
      role="status"
      aria-label="独立提示重复提醒"
    >
      <strong>另有 {result.data.total} 张词卡使用相同独立提示</strong>
      <p>
        {result.data.items.map((item) => item.headword || item.title).join('、')}
        {result.data.total > result.data.items.length ? '等' : ''}
        。这只是歧义线索，不表示它们在所有语境中等价。
      </p>
      <p>可补充具体语境、核对允许答案，或关闭本卡逆向练习。此提醒不阻止保存。</p>
    </div>
  );
}
