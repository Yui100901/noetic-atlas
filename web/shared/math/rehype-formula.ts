/** Only Markdown math nodes reach these generated attributes. Raw source HTML
 * stays disabled, and source positions remain intact for citation highlights. */
interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: unknown;
}
const codeMath = (node: Node) =>
  node.tagName === 'code' &&
  Array.isArray(node.properties?.className) &&
  (node.properties!.className as string[]).some((name) =>
    ['language-math', 'math-inline', 'math-display'].includes(name),
  );
const text = (node: Node): string => node.value ?? (node.children || []).map(text).join('');
export function rehypeFormula() {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value),
      warnings = new Set<string>();
    const raw = (node: Node) => {
      const position = node.position as
        { start?: { offset?: number }; end?: { offset?: number } } | undefined;
      return source.slice(position?.start?.offset ?? 0, position?.end?.offset ?? 0);
    };
    const hasDollar = (value: string) => {
      for (let i = 0; i < value.length; i++)
        if (value[i] === '$') {
          let slashes = 0;
          for (let j = i - 1; j >= 0 && value[j] === '\\'; j--) slashes++;
          if (slashes % 2 === 0) return true;
        }
      return false;
    };
    let count = 0;
    const visit = (node: Node) => {
      node.children = node.children?.map((child) => {
        const block =
          child.tagName === 'pre' && child.children?.length === 1 && codeMath(child.children[0]!);
        if (block || codeMath(child)) {
          count++;
          const value = raw(child),
            opening = /^\$+/.exec(value)?.[0];
          if (
            opening &&
            (!value.trimEnd().endsWith(opening) || value.trimEnd().length < opening.length * 2)
          )
            warnings.add('公式块的分隔符未闭合，请检查源码。');
          if (count > 500) {
            warnings.add('单个字段最多排版500个公式，超出部分显示源码。');
            return {
              type: 'element',
              tagName: 'code',
              properties: {},
              children: [{ type: 'text', value: text(block ? child.children![0]! : child) }],
              position: child.position,
            };
          }
          return {
            type: 'element',
            tagName: block ? 'div' : 'span',
            properties: {
              'data-tex': text(block ? child.children![0]! : child),
              'data-math-display': block ? 'true' : 'false',
            },
            children: [],
            position: child.position,
          };
        }
        if (child.tagName === 'code' || child.tagName === 'pre') return child;
        if (child.type === 'text' && hasDollar(raw(child)))
          warnings.add('公式分隔符可能未闭合；普通金额中的美元符号请写成 \\$。');
        visit(child);
        return child;
      });
    };
    visit(tree);
    if (warnings.size)
      tree.children?.push({
        type: 'element',
        tagName: 'div',
        properties: { className: ['notice', 'math-format-warning'], role: 'note' },
        children: [{ type: 'text', value: [...warnings].join(' ') }],
      });
  };
}
