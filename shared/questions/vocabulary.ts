import type { VocabularyData } from '../models/types.js';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').trim();
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reject literal answer/readings, Markdown links/images, and hidden material.
 * Hints are a separately stored gloss, never the original explanation reversed. */
export function vocabularyPromptIsSafe(value: VocabularyData): boolean {
  const prompt=normalize(value.meaningPrompt);
  if(!prompt||/https?:|#\/|!\[|<[^>]*>|```/.test(prompt))return false;
  const forbidden=[value.headword,...value.acceptedAnswers,...value.pronunciations.flatMap(item=>[item.ipa,item.kana,item.romaji].filter((item):item is string=>!!item))];
  return forbidden.every(raw=>{const token=normalize(raw).replace(/^\/|\/$/g,'');if(!token)return true;return /^[a-z0-9' -]+$/i.test(token)?!new RegExp(`(^|[^a-z0-9])${escaped(token)}($|[^a-z0-9])`,'i').test(prompt):!prompt.includes(token);});
}

export function vocabularyPronunciationMarkdown(value?: VocabularyData): string {
  if(!value)return '';
  return '### 读音\n\n'+value.pronunciations.map(item=>`- **${item.label}**：${item.ipa||`${item.kana} · ${item.romaji}`}${item.method==='expanded'?'（展开读法）':item.method==='manual'?'（补充核对）':''}`).join('\n');
}
