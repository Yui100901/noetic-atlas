import { useId } from 'react';
import type { PaperPracticeKind, VocabularyDirection } from '../../../shared/models/types';

export type { VocabularyDirection } from '../../../shared/models/types';
export function vocabularyDirectionLabel(direction?: string, kind?: PaperPracticeKind): string {
  if (kind === 'concept') return direction === 'meaning_to_word' ? '逆向 · 看描述想概念' : direction === 'word_to_meaning' ? '顺向 · 看概念想含义' : '';
  return direction === 'meaning_to_word' ? '逆向 · 看释义想单词' : direction === 'word_to_meaning' ? '顺向 · 看单词想释义' : '';
}

export function VocabularyDirectionFields({ value, onChange, kind }: { value: VocabularyDirection; onChange: (value: VocabularyDirection) => void; kind?: PaperPracticeKind }) {
  const name = useId();
  if (kind === 'concept') return <fieldset className="vocabulary-direction-fields"><legend>练习方向</legend><div>
    <label className={value === 'word_to_meaning' ? 'selected' : ''}><input type="radio" name={name} value="word_to_meaning" checked={value === 'word_to_meaning'} onChange={() => onChange('word_to_meaning')} /><span><strong>顺向：看概念想含义</strong><small>根据名称回忆概念含义，交卷后对照详细解析。</small></span></label>
    <label className={value === 'meaning_to_word' ? 'selected' : ''}><input type="radio" name={name} value="meaning_to_word" checked={value === 'meaning_to_word'} onChange={() => onChange('meaning_to_word')} /><span><strong>逆向：看描述想概念</strong><small>根据独立定义填写概念名称，自动核对主词及已收录别称。</small></span></label>
  </div></fieldset>;
  return <fieldset className="vocabulary-direction-fields"><legend>练习方向</legend><div>
    <label className={value === 'word_to_meaning' ? 'selected' : ''}><input type="radio" name={name} value="word_to_meaning" checked={value === 'word_to_meaning'} onChange={() => onChange('word_to_meaning')} /><span><strong>顺向：看单词想释义</strong><small>根据单词回忆含义，提交后对照解析并评价掌握程度。</small></span></label>
    <label className={value === 'meaning_to_word' ? 'selected' : ''}><input type="radio" name={name} value="meaning_to_word" checked={value === 'meaning_to_word'} onChange={() => onChange('meaning_to_word')} /><span><strong>逆向：看释义想单词</strong><small>根据独立释义填写原词，自动核对；作答时隐藏原词、读音与例句。</small></span></label>
  </div></fieldset>;
}
