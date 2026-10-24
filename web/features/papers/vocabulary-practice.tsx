import { useId } from 'react';
import type { VocabularyDirection } from '../../../shared/models/types';

export type { VocabularyDirection } from '../../../shared/models/types';
export function vocabularyDirectionLabel(direction?: string): string {
  return direction === 'meaning_to_word' ? '逆向 · 看释义想单词' : direction === 'word_to_meaning' ? '顺向 · 看单词想释义' : '';
}

export function VocabularyDirectionFields({ value, onChange }: { value: VocabularyDirection; onChange: (value: VocabularyDirection) => void }) {
  const name = useId();
  return <fieldset className="vocabulary-direction-fields"><legend>练习方向</legend><div>
    <label className={value === 'word_to_meaning' ? 'selected' : ''}><input type="radio" name={name} value="word_to_meaning" checked={value === 'word_to_meaning'} onChange={() => onChange('word_to_meaning')} /><span><strong>顺向：看单词想释义</strong><small>根据单词回忆含义，提交后对照解析并评价掌握程度。</small></span></label>
    <label className={value === 'meaning_to_word' ? 'selected' : ''}><input type="radio" name={name} value="meaning_to_word" checked={value === 'meaning_to_word'} onChange={() => onChange('meaning_to_word')} /><span><strong>逆向：看释义想单词</strong><small>根据独立释义填写原词，自动核对；作答时隐藏原词、读音与例句。</small></span></label>
  </div></fieldset>;
}
