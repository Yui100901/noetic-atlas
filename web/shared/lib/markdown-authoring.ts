/** Text-only editing operations use the same UTF-16 offsets as a textarea. */
export type MarkdownAction = 'heading' | 'bold' | 'italic' | 'strike' | 'quote' | 'code' | 'code-block' | 'link' | 'unordered-list' | 'ordered-list' | 'task-list' | 'table' | 'rule';
export interface MarkdownEdit { value: string; selectionStart: number; selectionEnd: number }

function range(value: string, start: number, end: number) {
  const clamp = (point: number) => Number.isFinite(point) ? Math.max(0, Math.min(value.length, Math.trunc(point))) : 0;
  return [Math.min(clamp(start), clamp(end)), Math.max(clamp(start), clamp(end))] as const;
}
function replace(value: string, start: number, end: number, text: string, selectedStart: number, selectedEnd = selectedStart): MarkdownEdit {
  return { value: value.slice(0, start) + text + value.slice(end), selectionStart: start + selectedStart, selectionEnd: start + selectedEnd };
}
export function insertMarkdownText(value: string, start: number, end: number, text: string): MarkdownEdit {
  const [from, to] = range(value, start, end);
  return replace(value, from, to, text, text.length);
}
function codeDelimiter(value: string, minimum: number): string {
  let length = minimum;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}
function wrap(value: string, start: number, end: number, marker: string, placeholder: string, padding = ''): MarkdownEdit {
  const text = value.slice(start, end);
  if (['**', '*', '~~'].includes(marker) && text && text !== text.trim()) {
    const leading = text.match(/^\s*/)![0].length;
    const trailing = text.slice(leading).match(/\s*$/)![0].length;
    return wrap(value, start + leading, end - trailing, marker, placeholder);
  }
  if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
    const inner = text.slice(marker.length, -marker.length);
    return replace(value, start, end, inner, 0, inner.length);
  }
  const adjacent = start >= marker.length && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker;
  const insideBold = marker === '*' && (value[start - 2] === '*' || value[end + 1] === '*');
  if (adjacent && !insideBold) {
    return replace(value, start - marker.length, end + marker.length, text, 0, text.length);
  }
  const content = text || placeholder, before = marker + padding;
  return replace(value, start, end, before + content + padding + marker, before.length, before.length + content.length);
}
function block(value: string, start: number, end: number, text: string, selectedStart: number, selectedEnd = selectedStart): MarkdownEdit {
  const before = value.slice(0, start), after = value.slice(end);
  const leading = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trailing = !after ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return replace(value, start, end, leading + text + trailing, leading.length + selectedStart, leading.length + selectedEnd);
}
const lineCommands = {
  heading: { match: /^([ \t]*)##[ \t]+/, remove: /^[ \t]*#{1,6}[ \t]+/, token: () => '## ', placeholder: '标题' },
  quote: { match: /^([ \t]*)>[ \t]?/, remove: /^[ \t]*>[ \t]?/, token: () => '> ', placeholder: '引用内容' },
  'unordered-list': { match: /^([ \t]*)[-+*][ \t]+/, remove: /^[ \t]*(?:[-+*]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/, token: () => '- ', placeholder: '列表项' },
  'ordered-list': { match: /^([ \t]*)\d+\.[ \t]+/, remove: /^[ \t]*(?:[-+*]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/, token: (index: number) => `${index + 1}. `, placeholder: '列表项' },
  'task-list': { match: /^([ \t]*)[-+*][ \t]+\[[ xX]\][ \t]+/, remove: /^[ \t]*(?:[-+*]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/, token: () => '- [ ] ', placeholder: '待办事项' },
};
type LineCommand = keyof typeof lineCommands;
function lines(value: string, start: number, end: number, action: LineCommand): MarkdownEdit {
  const from = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
  // A selection ending at the next line's first column excludes that line.
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = value.indexOf('\n', last), to = nextBreak < 0 ? value.length : nextBreak;
  const source = value.slice(from, to).split('\n'), config = lineCommands[action];
  const matches = (line: string) => config.match.test(line) && (action !== 'unordered-list' || !lineCommands['task-list'].match.test(line));
  const nonempty = source.filter(line => line.trim()), removing = nonempty.length > 0 && nonempty.every(matches);
  let index = 0, oldOffset = from, newOffset = from;
  const mapped: Array<{ old: number; length: number; next: number; removed: number; added: number; size: number }> = [];
  const changed = source.map(line => {
    if (!line.trim() && source.length > 1) {
      mapped.push({ old: oldOffset, length: line.length, next: newOffset, removed: 0, added: 0, size: line.length });
      oldOffset += line.length + 1; newOffset += line.length + 1;
      return line;
    }
    const indent = line.match(/^[ \t]*/)![0];
    const removed = removing ? line.match(config.match)?.[0].length || 0 : line.match(config.remove)?.[0].length || indent.length;
    const added = removing || !line.trim() && source.length > 1 ? indent : indent + config.token(index++);
    const content = line.slice(removed) || (source.length === 1 && !removing ? config.placeholder : '');
    const result = added + content;
    mapped.push({ old: oldOffset, length: line.length, next: newOffset, removed, added: added.length, size: result.length });
    oldOffset += line.length + 1; newOffset += result.length + 1;
    return result;
  }).join('\n');
  const map = (point: number) => {
    if (point > to) return from + changed.length + point - to;
    const line = mapped.find(line => point <= line.old + line.length) || mapped[mapped.length - 1]!;
    return line.next + Math.min(line.size, line.added + Math.max(0, point - line.old - line.removed));
  };
  if (source.length === 1 && !source[0]!.trim() && !removing) return replace(value, from, to, changed, mapped[0]!.added, changed.length);
  return { value: value.slice(0, from) + changed + value.slice(to), selectionStart: map(start), selectionEnd: map(end) };
}
export function applyMarkdownAction(value: string, start: number, end: number, action: MarkdownAction): MarkdownEdit {
  const [from, to] = range(value, start, end), selected = value.slice(from, to);
  switch (action) {
    case 'bold': return wrap(value, from, to, '**', '粗体文字');
    case 'italic': return wrap(value, from, to, '*', '强调文字');
    case 'strike': return wrap(value, from, to, '~~', '删除文字');
    case 'code': {
      const marker = codeDelimiter(selected, 1);
      return wrap(value, from, to, marker, '代码', /^`|`$/.test(selected) || /^ .+ $/.test(selected) && selected.trim() ? ' ' : '');
    }
    case 'heading': case 'quote': case 'unordered-list': case 'ordered-list': case 'task-list': return lines(value, from, to, action);
    case 'code-block': {
      const content = selected || '代码内容', fence = codeDelimiter(content, 3);
      return block(value, from, to, `${fence}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`, fence.length + 1, fence.length + 1 + content.length);
    }
    case 'link': {
      const urlSelected = /^https?:\/\/\S+$/.test(selected), text = urlSelected ? '链接文字' : (selected || '链接文字').replace(/\n/g, ' ').replace(/[\[\]]/g, '\\$&');
      const url = urlSelected ? selected.replace(/[()]/g, '\\$&') : 'https://example.com';
      const result = `[${text}](${url})`;
      return replace(value, from, to, result, selected && !urlSelected ? text.length + 3 : 1, selected && !urlSelected ? text.length + 3 + url.length : 1 + text.length);
    }
    case 'table': {
      const rows = selected ? selected.split('\n').map(line => line.split('\t')) : [['内容', '内容']];
      const columns = rows.reduce((maximum, row) => Math.max(maximum, row.length), 2);
      const rowText = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => (cells[index] || '').replace(/\|/g, '\\|')).join(' | ')} |`;
      const table = [rowText(Array.from({ length: columns }, (_, index) => `列${index + 1}`)), rowText(Array(columns).fill('---')), ...rows.map(rowText)].join('\n');
      return block(value, from, to, table, 2, 4);
    }
    case 'rule': {
      const result = block(value, from, from, '---', 3);
      const cursor = result.selectionEnd + (result.value.slice(result.selectionEnd).startsWith('\n\n') ? 2 : 1);
      return { ...result, selectionStart: cursor, selectionEnd: cursor };
    }
  }
}
