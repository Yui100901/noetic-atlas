/** Persisted source coordinates use PDF points, with the origin at bottom left. */
export const PDF_TEXT_VERSION = 1;
export interface PdfTextItem {
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PdfExtractedPage {
  pageNumber: number;
  text: string;
  width: number;
  height: number;
  items: PdfTextItem[];
}
export interface PdfPage extends PdfExtractedPage {
  id: string;
  cacheId: string;
  normalized: string;
}
export interface PdfCache {
  id: string;
  contentHash: string;
  extractorVersion: number;
  pageCount: number;
  processedPages: number;
  textPages: number;
  status: 'queued' | 'indexing' | 'ready' | 'needs_ocr';
  updatedAt: string;
}
export interface PdfJob {
  id: string;
  assetId: string;
  cacheId: string;
  filename: string;
  status: 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled';
  nextPage: number;
  pageCount: number;
  updatedAt: string;
  error?: string;
  lease?: string;
  leaseUntil?: string;
}
export interface PdfHit {
  pageNumber: number;
  excerpt: string;
  href?: string;
}
export function normalizePdfText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      '$1',
    )
    .replace(/\s+/gu, ' ')
    .trim();
}
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Singles support short searches; bigrams reduce large CJK candidate sets. */
export function pdfSearchTokens(value: string): string[] {
  const normalized = normalizePdfText(value),
    tokens = new Set<string>();
  for (const word of normalized.match(/[\p{L}\p{N}_]+/gu) || []) {
    let run = '';
    for (const ch of word) {
      if (cjk.test(ch)) {
        if (run) {
          tokens.add(run);
          run = '';
        }
        tokens.add(ch);
      } else run += ch;
    }
    if (run) tokens.add(run);
    const chars = [...word];
    for (let i = 0; i < chars.length - 1; i++)
      if (cjk.test(chars[i]!) && cjk.test(chars[i + 1]!)) tokens.add(chars[i]! + chars[i + 1]!);
  }
  return [...tokens];
}
export function pdfTextMatches(text: string, query: string): boolean {
  const normalized = normalizePdfText(text);
  return normalizePdfText(query)
    .split(' ')
    .filter(Boolean)
    .every((term) => normalized.includes(term));
}
export function pdfExcerpt(text: string, query: string, size = 180): string {
  const normalized = normalizePdfText(text),
    term = normalizePdfText(query).split(' ')[0] || '',
    at = Math.max(0, normalized.indexOf(term)),
    start = Math.max(0, at - 45);
  return `${start ? '…' : ''}${normalized.slice(start, start + size)}${normalized.length > start + size ? '…' : ''}`;
}
/** Locate matching glyph runs without executing PDF text as HTML. The mapping
 * survives NFKC expansion and PDF.js' spaces between CJK text items. */
export function pdfMatchingItems(items: Pick<PdfTextItem, 'text'>[], query: string): Set<number> {
  const chars: Array<{ ch: string; owner: number }> = [];
  items.forEach((item, owner) => {
    for (const source of item.text)
      for (const ch of source.normalize('NFKC').toLocaleLowerCase('en-US'))
        chars.push({ ch, owner });
    chars.push({ ch: ' ', owner });
  });
  const mapped: Array<{ ch: string; owner: number }> = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (/\s/u.test(ch.ch)) {
      let next = i + 1;
      while (next < chars.length && /\s/u.test(chars[next]!.ch)) next++;
      if (
        mapped.length &&
        next < chars.length &&
        !(cjk.test(mapped.at(-1)!.ch) && cjk.test(chars[next]!.ch))
      )
        mapped.push({ ch: ' ', owner: ch.owner });
      i = next - 1;
    } else mapped.push(ch);
  }
  const text = mapped.map((item) => item.ch).join(''),
    owners = mapped.flatMap((item) => Array(item.ch.length).fill(item.owner) as number[]),
    found = new Set<number>();
  for (const term of normalizePdfText(query).split(' ').filter(Boolean)) {
    let at = text.indexOf(term);
    while (at >= 0) {
      for (let i = at; i < at + term.length; i++) found.add(owners[i]!);
      at = text.indexOf(term, at + Math.max(1, term.length));
    }
  }
  return found;
}
