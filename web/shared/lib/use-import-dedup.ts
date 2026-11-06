import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportDedupDecision, ImportDedupPreview } from '../../../shared/models/import-dedup';
import type { QuestionInput } from '../../../shared/models/types';
import { request } from './api';
import { unresolvedImportItems } from './import-review-state';

/** Review results belong to the precise selected input. Editing the JSON,
 * taxonomy or selection invalidates them without discarding the source draft. */
export function useImportDedup(inputSignature: string) {
  const [enabled, setEnabled] = useState(true);
  const signature = JSON.stringify([inputSignature, enabled]);
  const [review, setReview] = useState<{
    signature: string;
    preview: ImportDedupPreview;
    questions: QuestionInput[];
  } | null>(null);
  const [decisions, setDecisions] = useState<ImportDedupDecision[]>([]);
  const generation = useRef(0),
    active = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    generation.current++;
    active.current?.abort();
    setReview(null);
    setDecisions([]);
  }, []);
  useEffect(() => {
    clear();
  }, [signature, clear]);
  useEffect(
    () => () => {
      generation.current++;
      active.current?.abort();
    },
    [],
  );
  const prepare = async (url: string, body: unknown, questions: QuestionInput[]) => {
    const version = ++generation.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const preview = await request<ImportDedupPreview>(url, {
      method: 'POST',
      body: JSON.stringify({ ...(body as Record<string, unknown>), dedup: { enabled } }),
      signal: controller.signal,
    });
    if (generation.current !== version || controller.signal.aborted) return;
    setReview({ signature, preview, questions: structuredClone(questions) });
    setDecisions([]);
  };
  const current = review?.signature === signature ? review : null;
  const readIncoming = useCallback(
    async (index: number) => {
      const item = current?.questions[index];
      if (!item) throw new Error('导入内容已经变化，请重新检查重复。');
      return item;
    },
    [current],
  );
  return {
    enabled,
    setEnabled,
    preview: current?.preview || null,
    decisions,
    setDecisions,
    readIncoming,
    prepare,
    clear,
    unresolved: current ? unresolvedImportItems(current.preview, decisions).length : 0,
    options: current
      ? { enabled, expectedFingerprint: current.preview.fingerprint, decisions }
      : { enabled },
  };
}
