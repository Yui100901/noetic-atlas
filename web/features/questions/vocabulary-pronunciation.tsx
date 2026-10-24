import type { VocabularyData } from '../../../shared/models/types';
import './vocabulary-pronunciation.css';

export function VocabularyPronunciation({ vocabulary }: { vocabulary?: VocabularyData }) {
  if(!vocabulary)return null;
  return <section className="vocabulary-pronunciation" aria-label="词语读音"><h3>读音</h3><dl>{vocabulary.pronunciations.map((item,index)=><div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd>{item.ipa?<span className="vocabulary-ipa">{item.ipa}</span>:<><span lang="ja">{item.kana}</span><span className="vocabulary-romaji">{item.romaji}</span></>}{item.method==='expanded'&&<small>按含义展开读法</small>}{item.method==='manual'&&<small>补充核对</small>}</dd></div>)}</dl><details><summary>读音来源</summary><ul>{vocabulary.pronunciations.map((item,index)=><li key={index}><a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">{item.label} · {item.sourceLabel}</a><span> · {item.license}</span>{item.method==='transliteration'&&<span> · 罗马音由本条假名按Hepburn规则转换，不表示声调。</span>}</li>)}</ul></details></section>;
}
