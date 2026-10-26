import type { SystemSettings } from '../../../shared/models/settings';
import { Field } from '../../shared/ui/components';
import './review-scheduling.css';

type ReviewSettings = SystemSettings['reviewScheduling'];

export function ReviewSchedulingSettings({ value, onChange, disabled = false }: { value: ReviewSettings; onChange: (value: ReviewSettings) => void; disabled?: boolean }) {
  const set = <K extends keyof ReviewSettings>(key: K, next: ReviewSettings[K]) => onChange({ ...value, [key]: next });
  return <section className="card settings-section settings-adaptive-review"><h2>自适应复习 · FSRS</h2>
    <div className="adaptive-settings-grid"><Field label="复习调度方式"><select disabled={disabled} value={value.strategy} onChange={event => set('strategy', event.target.value as ReviewSettings['strategy'])}><option value="fsrs">FSRS 自适应复习</option><option value="fixed">固定复习间隔</option></select></Field>
      <Field label="目标记忆率（%）" hint="这是调度目标，目标越高通常需要更多复习。"><input disabled={disabled || value.strategy !== 'fsrs'} required type="number" min="70" max="99" step="1" value={Math.round(value.desiredRetention * 100)} onChange={event => set('desiredRetention', Number(event.target.value) / 100)} /></Field>
      <Field label="最长复习间隔（天）"><input disabled={disabled || value.strategy !== 'fsrs'} required type="number" min="1" max="36500" value={value.maximumIntervalDays} onChange={event => set('maximumIntervalDays', Number(event.target.value))} /></Field>
    </div>
    <div className="adaptive-settings-options"><label><input disabled={disabled || value.strategy !== 'fsrs'} type="checkbox" checked={value.autoRateObjective} onChange={event => set('autoRateObjective', event.target.checked)} />客观题提交后自动记录回忆结果：正确为良好，错误为重学；可在交卷后更正。</label>
      <label><input disabled={disabled || value.strategy !== 'fsrs'} type="checkbox" checked={value.reduceNewWhenOverdue} onChange={event => set('reduceNewWhenOverdue', event.target.checked)} />复习积压时，允许每日推荐减少新题并优先安排到期复习。</label>
      <label><input disabled={disabled || value.strategy !== 'fsrs'} type="checkbox" checked={value.enableFuzz} onChange={event => set('enableFuzz', event.target.checked)} />对较长间隔作小幅随机调整，分散同日到期任务。</label>
    </div>
    <details className="adaptive-settings-advanced"><summary>短期学习与重学步骤</summary><div className="adaptive-settings-grid">
      <StepInput label="初学步骤（分钟）" value={value.learningStepsMinutes} disabled={disabled || value.strategy !== 'fsrs'} onChange={next => set('learningStepsMinutes', next)} />
      <StepInput label="重学步骤（分钟）" value={value.relearningStepsMinutes} disabled={disabled || value.strategy !== 'fsrs'} onChange={next => set('relearningStepsMinutes', next)} />
    </div></details>
    <p className="adaptive-settings-help">掌握程度0–3与回忆评级分开记录。“困难”表示独立答对但吃力，关键遗漏应选择“重学”。漏答、未判、只看解析不会被当作遗忘事件。原有到期日期保留，从之后的有效复习开始更新；更改参数不批量改写已有排期。固定间隔仍可在下方配置。</p>
  </section>;
}

function StepInput({ label, value, onChange, disabled }: { label: string; value: number[]; onChange: (value: number[]) => void; disabled: boolean }) {
  return <div className="field review-steps-field"><span className="field-label">{label}</span><div className="review-steps-list">{value.map((minutes, index) => <div key={index}><span>第{index + 1}步</span><input disabled={disabled} required type="number" min="1" max="1440" step="1" aria-label={`${label}第${index + 1}步`} value={minutes} onChange={event => onChange(value.map((before, at) => at === index ? Number(event.target.value) : before))} /><button className="button" type="button" disabled={disabled || value.length <= 1} aria-label={`移除${label}第${index + 1}步`} onClick={() => onChange(value.filter((_before, at) => at !== index))}>移除</button></div>)}</div><button className="button" type="button" disabled={disabled || value.length >= 10} onClick={() => onChange([...value, 10])}>添加步骤</button><small>最多10步，每步1至1440分钟。</small></div>;
}
