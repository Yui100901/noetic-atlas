import type { ConceptData } from '../../../shared/models/types';
import { Field } from '../../shared/ui/components';

export function ConceptEditor({ value, title, onChange }: { value?: ConceptData; title: string; onChange: (value?: ConceptData) => void }) {
  return <section className="form-stack concept-editor"><label className="checkbox-line"><input type="checkbox" checked={!!value} onChange={event => onChange(event.target.checked ? { term: title.trim(), meaningPrompt: '', acceptedAnswers: [title.trim()] } : undefined)} />作为可双向练习的概念卡</label>{value && <>
    <Field label="概念主词" hint="例如：沉没成本。可在概念题集中看名称想含义，或看独立定义想名称。"><input required maxLength={300} value={value.term} onChange={event => { const term = event.target.value; onChange({ ...value, term, acceptedAnswers: [term, ...value.acceptedAnswers.filter(answer => answer !== value.term)] }); }} /></Field>
    <Field label="概念独立定义" hint="用于逆向练习；不能含概念名称、别称、缩写或答案链接，不能直接复制含例子的详细解析。"><textarea required rows={3} maxLength={3000} value={value.meaningPrompt} onChange={event => onChange({ ...value, meaningPrompt: event.target.value })} placeholder="已经发生且无法收回的支出" /></Field>
    <Field label="概念可接受答案" hint="每行一个主词或真实别称，须包含上方主词；逆向作答按这些名称精确核对。"><textarea required rows={3} value={value.acceptedAnswers.join('\n')} onChange={event => onChange({ ...value, acceptedAnswers: event.target.value.split('\n') })} /></Field>
  </>}</section>;
}
