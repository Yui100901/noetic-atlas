import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export interface MathNode {
  type: string;
  value?: string;
  lang?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MathNode[];
}
export interface MathExpression {
  source: string;
  display: boolean;
  start: number;
  end: number;
  closed: boolean;
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const plainParser = unified().use(remarkParse).use(remarkGfm);
export const MATH_LIMITS = {
  sourceCharacters: 8000,
  expressionsPerField: 500,
  cacheEntries: 256,
  cacheCharacters: 2_000_000,
  maxExpand: 500,
  maxSize: 10,
} as const;
export function mathTree(text: string): MathNode {
  return parser.parse(text) as MathNode;
}
const unescaped = (text: string, index: number) => {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 0;
};
/** Parser positions are offsets in the unchanged source, shared by quality,
 * exports and source citations. Code examples and link destinations stay literal. */
export function mathExpressions(text: string): MathExpression[] {
  const result: MathExpression[] = [];
  const visit = (node: MathNode) => {
    const start = node.position?.start.offset ?? 0,
      end = node.position?.end.offset ?? start;
    if (
      node.type === 'math' ||
      node.type === 'inlineMath' ||
      (node.type === 'code' && node.lang === 'math')
    ) {
      const raw = text.slice(start, end),
        fenced = node.type === 'code',
        opening = fenced ? /^\s*(`{3,}|~{3,})/.exec(raw)?.[1] : /^\$+/.exec(raw)?.[0];
      const closed =
        !!opening && raw.trimEnd().endsWith(opening) && raw.trimEnd().length >= opening.length * 2;
      result.push({
        source: node.value || '',
        display: node.type !== 'inlineMath',
        start,
        end,
        closed,
      });
      return;
    }
    for (const child of node.children || []) visit(child);
  };
  visit(mathTree(text));
  return result;
}
export function hasMath(text: string): boolean {
  return /\$|```math|~~~math/.test(text) && mathExpressions(text).length > 0;
}
/** Escape only text-node dollars when mixing formula-enabled and ordinary
 * questions in one Markdown/PDF export. Never touch persisted content or code. */
export function literalMathMarkdown(text: string): string {
  if (!text.includes('$')) return text;
  const inserts: number[] = [];
  const visit = (node: MathNode) => {
    if (node.type === 'text' && node.position) {
      const start = node.position.start.offset ?? 0,
        end = node.position.end.offset ?? start;
      for (let i = start; i < end; i++) if (text[i] === '$' && unescaped(text, i)) inserts.push(i);
    } else for (const child of node.children || []) visit(child);
  };
  visit(plainParser.parse(text) as MathNode);
  let value = text;
  for (const index of inserts.sort((a, b) => b - a))
    value = value.slice(0, index) + '\\' + value.slice(index);
  return value;
}
export function mathDelimiterErrors(text: string): Array<{ start: number; message: string }> {
  const errors: Array<{ start: number; message: string }> = [];
  const visit = (node: MathNode) => {
    if (node.type === 'text' && node.position) {
      const start = node.position.start.offset ?? 0,
        end = node.position.end.offset ?? start;
      for (let i = start; i < end; i++)
        if (text[i] === '$' && unescaped(text, i)) {
          errors.push({ start: i, message: '公式分隔符未闭合；普通金额中的美元符号请写成 \\$' });
          break;
        }
    } else for (const child of node.children || []) visit(child);
  };
  visit(mathTree(text));
  return errors;
}
