import { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { ApiError, request, send } from '../../shared/lib/api';
import { ErrorNotice, Modal, useApp } from '../../shared/ui/components';

interface LearningResetPreview {
  fingerprint: string;
  counts: { states: number; partStates: number; reviews: number; results: number };
  retained: { attempts: number; drafts: number };
}

/** Learning progress is reset separately from retention and preference changes. */
export function LearningReset() {
  const { reload, toast } = useApp();
  const [preview, setPreview] = useState<LearningResetPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);
  const pending = useRef(false);

  const inspect = async () => {
    if (pending.current) return;
    pending.current = true; setBusy('preview'); setError(''); setDone(false); setConfirmed(false); setPreview(null);
    try {
      setPreview(await request<LearningResetPreview>('/api/learning/reset-preview'));
      setExpired(false);
    } catch (reason) { setError((reason as Error).message); }
    finally { pending.current = false; setBusy(null); }
  };
  const apply = async () => {
    if (pending.current || !preview || !confirmed) return;
    pending.current = true; setBusy('apply'); setError('');
    try {
      await send('/api/learning/reset', 'POST', { confirmed: true, fingerprint: preview.fingerprint });
      setPreview(null); setConfirmed(false); setDone(true); reload(); toast('学习进度已重置，收藏、笔记和历史答题保留');
    } catch (reason) {
      setConfirmed(false);
      if (reason instanceof ApiError && reason.status === 409) {
        setPreview(null); setExpired(true);
        setError('学习进度已变化，预览已过期。请重新预览并确认后再重置。');
      } else setError((reason as Error).message);
    } finally { pending.current = false; setBusy(null); }
  };
  const close = () => { if (!pending.current) { setPreview(null); setConfirmed(false); } };

  return <section className="card settings-section" aria-label="重置学习进度">
    <h2>重置学习进度</h2>
    <p>重新开始记录掌握程度、复习安排与错题。此操作会清除原题及组合小题的掌握程度、复习日期、错题状态与错误统计，并移除复习事件。</p>
    <p className="muted">题目、题集、收藏、笔记、历史答题与成绩、作答草稿继续保留。清理超限历史不会重置学习进度；此入口单独处理学习进度。</p>
    <button type="button" className="button danger-text" disabled={busy !== null} onClick={() => void inspect()}><RotateCcw size={16} />{busy === 'preview' ? '正在预览影响…' : expired ? '重新预览重置范围' : '预览重置范围'}</button>
    {error && !preview && <ErrorNotice message={error} />}
    {done && <p className="notice success" role="status">学习进度已重置。收藏、笔记、历史成绩和草稿均已保留。</p>}
    {preview && <Modal title="确认重置学习进度" onClose={close}>
      <p>本次将重置 <strong>{preview.counts.states.toLocaleString()} 份原题学习状态</strong>、<strong>{preview.counts.partStates.toLocaleString()} 份组合小题状态</strong>，清除 <strong>{preview.counts.results.toLocaleString()} 份答题学习结果</strong> 和 <strong>{preview.counts.reviews.toLocaleString()} 条复习事件</strong>。</p>
      <p>掌握程度、上次与下次复习日期、错题状态和错误统计将清空。保留题目、题集、收藏和笔记，以及 <strong>{preview.retained.attempts.toLocaleString()} 份历史答题及成绩</strong>、<strong>{preview.retained.drafts.toLocaleString()} 份作答草稿</strong>。</p>
      <p className="muted">此操作不能从当前库撤销。需要保留现有学习进度时，可先取消并到“数据与备份”导出完整备份。</p>
      {error && <ErrorNotice message={error} />}
      <label className="check-row"><input type="checkbox" checked={confirmed} disabled={busy !== null} onChange={event => setConfirmed(event.target.checked)} />我确认清除上述学习进度，并保留收藏、笔记、历史成绩和草稿</label>
      <div className="form-actions"><button type="button" className="button" disabled={busy !== null} onClick={close}>取消</button><button type="button" className="button primary" disabled={busy !== null || !confirmed} onClick={() => void apply()}>{busy === 'apply' ? '正在重置…' : '确认重置学习进度'}</button></div>
    </Modal>}
  </section>;
}
