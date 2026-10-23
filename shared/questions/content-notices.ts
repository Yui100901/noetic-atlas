import { unified } from 'unified';
import remarkParse from 'remark-parse';

export interface ContentNotice {
  title: string;
  /** Exact source Markdown, except the verified English wrapper can be split
   * into independent fenced notices without changing the license text. */
  markdown: string;
  kind?: 'license' | 'learning';
}
interface MarkdownNode {
  type: string; depth?: number; value?: string; children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
const parser = unified().use(remarkParse);
const sectionTitles = new Set(['数据许可与完整署名声明', '来源与许可', '来源与授权', '学习与审核说明']);
const englishWrapper = '以下声明随单题一并保留。全包来源与变更记录另见随包 english-NOTICE.md。';
const learningParagraphs = new Set([
  '请回忆其英文含义、中文释义、主要词性及使用方式；可尝试先口头或书面造句，再查看释义与来源用例。',
  '可先回忆再查看答案；参考释义和例句需经人工审核。',
]);
const plainText = (node: MarkdownNode): string => node.value ?? (node.children || []).map(plainText).join('');
const startOffset = (node: MarkdownNode) => node.position?.start.offset;
const endOffset = (node: MarkdownNode) => node.position?.end.offset;
const framePlaceholders: Record<string, string> = { '介词短语': 'prep. phrase', '形容词': 'adj.', '不定式': 'inf.', '某人': 'sb.', '某物': 'sth.', '动词': 'v.', '名词': 'n.' };
const wordnetFrame = /^([^\r\n]+?)（WordNet 框架\s*\d+；义项\s*\d{8}-[nvars]）$/;
const wordnetExample = /^（Princeton WordNet 3\.0；义项\s*\d{8}-[nvars] 原例句）$/;
const wordnetPartOfSpeech = /^\*\*((?:noun \/ 名词|verb \/ 动词|adjective \/ 形容词|adverb \/ 副词)) · \d{8}-[nvars]\*\*$/;
function annotateFrame(source: string) {
  return source.replace(/介词短语|形容词|不定式|某人|某物|动词|名词/g, (label, offset: number) => {
    const annotation = `（${framePlaceholders[label]}）`;
    return source.startsWith(annotation, offset + label.length) ? label : label + annotation;
  });
}

/** Split only the generator's exact wrapper. Unknown prose, extra paragraphs,
 * altered instructions and unfamiliar layouts retain their entire section. */
function splitEnglishNotice(source: string): ContentNotice[] | undefined {
  const heading = '### 数据许可与完整署名声明';
  if (!source.startsWith(heading)) return;
  const afterHeading = source.slice(heading.length);
  const eol = afterHeading.startsWith('\r\n') ? '\r\n' : afterHeading.startsWith('\n') ? '\n' : afterHeading.startsWith('\r') ? '\r' : undefined;
  if (!eol) return;
  const prefix = `${heading}${eol}${englishWrapper}${eol}${eol}\`\`\`text${eol}`;
  if (!source.startsWith(prefix)) return;
  // The only text allowed after the closing fence is section spacing. Keep
  // unknown additions in one complete notice rather than silently losing them.
  let end = source.length;
  while (end >= eol.length && source.slice(end - eol.length, end) === eol) end -= eol.length;
  const suffix = `${eol}\`\`\``;
  if (!source.slice(0, end).endsWith(suffix)) return;
  const payload = source.slice(prefix.length, end - suffix.length);
  if (payload.includes(`${eol}\`\`\``)) return;
  const fenced = (title: string, markdown: string): ContentNotice => ({ title, markdown: `\`\`\`text${eol}${markdown}${eol}\`\`\`` });
  const princeton = 'Princeton WordNet 3.0', chinese = 'Chinese Open WordNet', ecdict = 'ECDICT metadata only';
  if (payload.startsWith(`${ecdict}${eol}`)) return [fenced(ecdict, payload)];
  if (!payload.startsWith(`${princeton}${eol}`)) return;
  const chineseBoundary = payload.indexOf(`${eol}${eol}${chinese}${eol}`);
  if (chineseBoundary < 0) return;
  const chineseStart = chineseBoundary + 2 * eol.length;
  const ecdictBoundary = payload.indexOf(`${eol}${eol}${ecdict}${eol}`, chineseStart);
  const notices = [fenced(princeton, payload.slice(0, chineseBoundary))];
  if (ecdictBoundary < 0) notices.push(fenced(chinese, payload.slice(chineseStart)));
  else {
    notices.push(fenced(chinese, payload.slice(chineseStart, ecdictBoundary)));
    notices.push(fenced(ecdict, payload.slice(ecdictBoundary + 2 * eol.length)));
  }
  return notices;
}

/** Presentation/export transform only. The stored question remains authoritative
 * so independent question sharing can always retain its full attribution. */
export function extractContentNotices(markdown: string): { markdown: string; notices: ContentNotice[] } {
  const root = parser.parse(markdown) as MarkdownNode;
  const nodes = root.children || [];
  const groups: { start: number; notices: ContentNotice[] }[] = [];
  const edits: { start: number; end: number; markdown: string }[] = [];
  const extract = (start: number, end: number, notices: ContentNotice[], replacement = '') => {
    groups.push({ start, notices }); edits.push({ start, end, markdown: replacement });
  };
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!, start = startOffset(node), end = endOffset(node);
    if (start === undefined || end === undefined) continue;
    const title = node.type === 'heading' ? plainText(node) : '';
    if (node.type === 'heading' && node.depth === 3 && sectionTitles.has(title)) {
      let next = index + 1;
      while (next < nodes.length && !(nodes[next]!.type === 'heading' && (nodes[next]!.depth || 7) <= 3)) next++;
      const stop = next < nodes.length ? startOffset(nodes[next]!)! : markdown.length;
      const source = markdown.slice(start, stop);
      const split = title === '数据许可与完整署名声明' ? splitEnglishNotice(source) : undefined;
      extract(start, stop, split || [{ title, markdown: source, ...(title === '学习与审核说明' ? { kind: 'learning' as const } : {}) }]); index = next - 1;
    } else if (node.type === 'heading' && node.depth === 3 && title === '词形变化（ECDICT 元数据）') {
      extract(start, end, [{ title: '词典数据索引', markdown: markdown.slice(start, end), kind: 'learning' }], '### 词形变化');
    } else if (node.type === 'paragraph' && node.children?.[0]?.type === 'strong' && plainText(node.children[0]) === '来源与许可') {
      // The fixed Japanese provenance paragraph starts with this strong label.
      // Never consume its following grade/coverage disclaimer paragraph.
      const source = markdown.slice(start, end);
      if (!source.startsWith('**来源与许可**：JMdict（') || !source.includes('JMdict源条目ID：')) continue;
      extract(start, end, [{ title: '来源与许可', markdown: source }]);
    } else if (node.type === 'paragraph' && learningParagraphs.has(markdown.slice(start, end))) {
      extract(start, end, [{ title: '学习说明', markdown: markdown.slice(start, end), kind: 'learning' }]);
    }
  }
  const visit = (node: MarkdownNode, parent?: MarkdownNode, listFrames?: Set<string>) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'blockquote') return;
    const start = startOffset(node), end = endOffset(node);
    if (start === undefined || end === undefined || edits.some(edit => start >= edit.start && end <= edit.end)) return;
    if (node.type === 'paragraph') {
      const source = markdown.slice(start, end);
      const simpleText = node.children?.every(child => child.type === 'text');
      const frame = simpleText ? wordnetFrame.exec(source) : null;
      if (frame && /^[A-Za-z][A-Za-z0-9 .'’_-]*：/.test(frame[1]!) && /介词短语|形容词|不定式|某人|某物|动词|名词/.test(frame[1]!)) {
        const itemStart = parent?.type === 'listItem' && parent.children?.length === 1 ? startOffset(parent) : undefined;
        const itemEnd = itemStart === undefined ? undefined : endOffset(parent!);
        const original = itemStart === undefined || itemEnd === undefined ? source : markdown.slice(itemStart, itemEnd);
        const display = annotateFrame(frame[1]!);
        const duplicate = itemStart !== undefined && itemEnd !== undefined && listFrames?.has(display);
        if (itemStart !== undefined && itemEnd !== undefined) listFrames?.add(display);
        extract(duplicate ? itemStart! : start, duplicate ? itemEnd! : end, [{ title: '词典数据索引', markdown: original, kind: 'learning' }], duplicate ? '' : display);
      } else if (simpleText && wordnetExample.test(source)) {
        extract(start, end, [{ title: '词典数据索引', markdown: source, kind: 'learning' }]);
      } else if (node.children?.length === 1 && node.children[0]?.type === 'strong' && wordnetPartOfSpeech.test(source)) {
        const match = wordnetPartOfSpeech.exec(source)!;
        extract(start, end, [{ title: '词典数据索引', markdown: source, kind: 'learning' }], `**${match[1]}**`);
      } else if (/^（Tatoeba 句子 #\d+，贡献者 /.test(source) && source.endsWith('）') && /\[原句\]\(https:\/\/tatoeba\.org\//.test(source) && /\[CC [^\]]+\]\(https:\/\/creativecommons\.org\/licenses\//.test(source)) {
        extract(start, end, [{ title: '例句来源与许可', markdown: source }]);
      }
      return;
    }
    const frames = node.type === 'list' ? new Set<string>() : listFrames;
    for (const child of node.children || []) visit(child, node, frames);
  };
  for (const node of nodes) visit(node);
  const notices = groups.sort((a, b) => a.start - b.start).flatMap(group => group.notices);
  if (!edits.length) return { markdown, notices };
  const pieces: string[] = []; let offset = 0;
  for (const range of edits.sort((a, b) => a.start - b.start)) { pieces.push(markdown.slice(offset, range.start), range.markdown); offset = range.end; }
  pieces.push(markdown.slice(offset));
  return { markdown: pieces.join(''), notices };
}

/** Exact, stable de-duplication: different URLs, entry IDs, revisions, spacing
 * and license clauses remain distinct. No normalization is applied. */
export function collectContentNotices(contents: string[]): ContentNotice[] {
  const seen = new Map<string, Set<string>>(), notices: ContentNotice[] = [];
  for (const content of contents) for (const notice of extractContentNotices(content).notices) {
    let texts = seen.get(notice.title); if (!texts) { texts = new Set(); seen.set(notice.title, texts); }
    if (texts.has(notice.markdown)) continue;
    texts.add(notice.markdown); notices.push(notice);
  }
  return notices;
}
