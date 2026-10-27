import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
interface Node { type: string; position?: {start:{offset?:number};end:{offset?:number}}; children?: Node[] }
export interface BlankMarker { marker: string; offset: number }
export const BLANK_LINE = '＿＿＿＿＿＿';

/** Only known authoring placeholders outside Markdown code are formatting
 * artifacts. Code samples, operators, indentation and literal templates stay. */
export function findBlankMarkers(markdown: string): BlankMarker[] {
  if (!/\{\{\s*(?:answer|blank)/i.test(markdown)) return [];
  const protectedRanges: Array<[number,number]> = [];
  const visit = (node: Node) => {
    if ((node.type === 'code' || node.type === 'inlineCode') && node.position?.start.offset !== undefined && node.position.end.offset !== undefined) protectedRanges.push([node.position.start.offset,node.position.end.offset]);
    else for (const child of node.children || []) visit(child);
  };
  visit(parser.parse(markdown) as Node);
  for (const match of markdown.matchAll(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) protectedRanges.push([match.index!,match.index!+match[0].length]);
  const matches: BlankMarker[] = [];
  for (const match of markdown.matchAll(/\{\{\s*(?:answer|blank)(?:(?:[_:\-]?\s*)\d+)?\s*\}\}/gi)) {
    const offset = match.index!;
    let escapes = 0; for (let at=offset-1;at>=0 && markdown[at]==='\\';at--) escapes++;
    if (escapes % 2 || protectedRanges.some(([start,end]) => offset>=start && offset<end)) continue;
    matches.push({marker:match[0],offset});
  }
  return matches;
}
export function normalizeBlankMarkers(markdown: string): string {
  const matches = findBlankMarkers(markdown); if (!matches.length) return markdown;
  let output='', cursor=0;
  for (const match of matches) { output+=markdown.slice(cursor,match.offset)+BLANK_LINE;cursor=match.offset+match.marker.length; }
  return output+markdown.slice(cursor);
}
export function questionStemMarkdown(question: {type:string;stemMarkdown:string}): string {
  return question.type === 'fill_blank' ? normalizeBlankMarkers(question.stemMarkdown) : question.stemMarkdown;
}
export function normalizeQuestionBlankStems<T extends {type:string;title?:string;stemMarkdown:string;parts?:Array<{type:string;title?:string;stemMarkdown:string}>}>(question:T):T {
  const stemMarkdown=questionStemMarkdown(question);
  const title=question.type==='fill_blank'&&typeof question.title==='string'?normalizeBlankMarkers(question.title):question.title;
  const parts=question.parts?.map(part=>{const stem=questionStemMarkdown(part),title=part.type==='fill_blank'&&typeof part.title==='string'?normalizeBlankMarkers(part.title):part.title;return stem===part.stemMarkdown&&title===part.title?part:{...part,stemMarkdown:stem,...(title!==undefined?{title}:{})};});
  return {...question,stemMarkdown,...(title!==undefined?{title}:{}),...(parts?{parts}: {})};
}
