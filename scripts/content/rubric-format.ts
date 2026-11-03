import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export interface RubricFormatIssue {
  code: string;
  message: string;
}
interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number; line?: number }; end: { offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const protectedTypes = new Set(['inlineCode', 'math', 'inlineMath']);
const nodeText = (node: Node): string => node.value ?? (node.children || []).map(nodeText).join('');
const bareLabel =
  /^(?:词性|主要释义|中文释义|英文释义|English definition|参考答案|答案说明|必要核对点|原题标准)\s*[：:]$/;

/** Structural validation of generated rubric Markdown, not a factual/semantic
 * rubric score. Code, tables and math are kept out of prose heuristics. An
 * absent rubric is valid; this helper does not create a new required field. */
export function inspectRubricFormat(markdown: string): RubricFormatIssue[] {
  if (!markdown.trim()) return [];
  const issues: RubricFormatIssue[] = [],
    seen = new Set<string>();
  const add = (code: string, message: string, node: Node) => {
    const line = node.position?.start.line;
    const key = `${code}:${line || 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push({ code, message: `${message}${line ? `（第${line}行）` : ''}` });
    }
  };
  const visit = (node: Node, parent?: Node) => {
    if (protectedTypes.has(node.type)) return;
    if (node.type === 'html') {
      add('hidden_html', '标准包含会被安全渲染器隐藏的HTML样式文本；标识符应使用代码或转义', node);
      return;
    }
    if (node.type === 'code') {
      const raw = markdown.slice(node.position?.start.offset || 0, node.position?.end.offset);
      const lines = raw.split(/\r?\n/),
        open = /^\s*(`{3,}|~{3,})/.exec(lines[0] || '');
      if (open) {
        const close = new RegExp(`^[ \\t]*${open[1]![0]}{${open[1]!.length},}[ \\t]*$`);
        if (lines.length < 2 || !close.test(lines.at(-1) || ''))
          add('unclosed_fence', '代码围栏未闭合，后续条目可能被当作代码', node);
      }
      return;
    }
    if (node.type === 'listItem') {
      if (!node.children?.length) add('empty_list_item', '列表项没有内容', node);
      else if (node.children.every((child) => child.type === 'list'))
        add('unlabelled_nested_list', '父列表项只有子列表，形成空编号或空项目符号', node);
    }
    if (node.type === 'heading' && !nodeText(node).trim())
      add('empty_heading', '标题只有标记而没有文字', node);
    if (node.type === 'paragraph' && node.children?.every((child) => child.type === 'text')) {
      const text = nodeText(node).trim();
      // Bare punctuation in prose/list points is a placeholder, unlike symbols
      // explicitly shown as inline code, math or table examples above.
      if (text && /^[，。；：、！？!?.,;:·…]+$/.test(text))
        add('punctuation_only_prose', '条目只有标点或省略号，没有可核对内容', node);
      if (parent?.type === 'listItem' && parent.children?.length === 1 && bareLabel.test(text))
        add('empty_label', '条目只有字段标签，缺少对应内容', node);
      if (/^\d+[.)、]$/.test(text)) add('orphan_number', '段落只有编号，缺少条目内容', node);
    }
    for (const child of node.children || []) visit(child, node);
  };
  visit(parser.parse(markdown) as Node);
  return issues;
}
