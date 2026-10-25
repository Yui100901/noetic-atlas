import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bold, Code2, CodeXml, Heading2, Italic, Link, List, ListChecks, ListOrdered, Minus, Quote, Redo2, Strikethrough, Table2, Undo2 } from 'lucide-react';
import { applyMarkdownAction, insertMarkdownText, type MarkdownAction } from '../lib/markdown-authoring';
import { ImageUploadButton } from '../media/asset-render';
import { Markdown } from './components';
import './markdown-editor.css';

interface Selection { selectionStart: number; selectionEnd: number }
interface Snapshot extends Selection { value: string }
interface MarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  label?: string;
  placeholder?: string;
  maxImageMiB?: number;
  disabled?: boolean;
}

const tools = [
  { action: 'heading', label: '二级标题', icon: Heading2 },
  { action: 'bold', label: '粗体', icon: Bold, shortcut: 'Ctrl/⌘+B' },
  { action: 'italic', label: '斜体', icon: Italic, shortcut: 'Ctrl/⌘+I' },
  { action: 'strike', label: '删除线', icon: Strikethrough },
  { action: 'quote', label: '引用', icon: Quote, separated: true },
  { action: 'code', label: '行内代码', icon: Code2 },
  { action: 'code-block', label: '代码块', icon: CodeXml },
  { action: 'unordered-list', label: '无序列表', icon: List, separated: true },
  { action: 'ordered-list', label: '有序列表', icon: ListOrdered },
  { action: 'task-list', label: '任务列表', icon: ListChecks },
  { action: 'link', label: '插入链接', icon: Link, shortcut: 'Ctrl/⌘+K', separated: true },
  { action: 'table', label: '插入表格', icon: Table2 },
  { action: 'rule', label: '分隔线', icon: Minus },
] satisfies Array<{ action: MarkdownAction; label: string; icon: typeof Bold; shortcut?: string; separated?: boolean }>;

// Bound the retained text as well as the number of edits. A large uploaded
// document must not create hundreds of full-size undo snapshots while typing.
function trimHistory(values: Snapshot[]): void {
  let size = values.reduce((sum, item) => sum + item.value.length, 0);
  while (values.length > 1 && (values.length > 100 || size > 2_000_000)) size -= values.shift()!.value.length;
}

/** A controlled Markdown textarea with selection-aware format transactions.
 * Preview uses the same renderer as saved documents; raw HTML is never enabled. */
export function MarkdownEditor({ value, onChange, label = '资料正文', placeholder = '## 我想理解的问题', maxImageMiB, disabled = false }: MarkdownEditorProps) {
  const editorId = useId(), textarea = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false), [historyVersion, setHistoryVersion] = useState(0);
  const current = useRef<Snapshot>({ value, selectionStart: 0, selectionEnd: 0 });
  const undo = useRef<Snapshot[]>([]), redo = useRef<Snapshot[]>([]);
  const pending = useRef<Selection | null>(null), composing = useRef(false);
  const lastTyping = useRef<{ time: number; inputType: string; end: number } | null>(null);
  const previousValue = useRef(value);
  // An external file import or another loaded document starts its own history.
  if (value !== previousValue.current) {
    previousValue.current = value;
    if (value !== current.current.value) {
      current.current = { value, selectionStart: Math.min(current.current.selectionStart, value.length), selectionEnd: Math.min(current.current.selectionEnd, value.length) };
      undo.current = []; redo.current = []; lastTyping.current = null;
    }
  }
  const rememberSelection = () => {
    const node = textarea.current;
    if (node) current.current = { ...current.current, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd };
  };
  useLayoutEffect(() => {
    if (!preview && pending.current && textarea.current) {
      const range = pending.current; pending.current = null;
      textarea.current.focus({ preventScroll: true }); textarea.current.setSelectionRange(range.selectionStart, range.selectionEnd);
    }
  }, [value, preview, historyVersion]);
  const restore = (snapshot: Snapshot) => {
    current.current = snapshot; pending.current = snapshot; lastTyping.current = null;
    onChange(snapshot.value); setHistoryVersion(version => version + 1);
  };
  const commit = (next: Snapshot, inputType?: string) => {
    const before = current.current;
    if (next.value === before.value) { pending.current = next; setHistoryVersion(version => version + 1); return; }
    const now = Date.now(), previous = lastTyping.current;
    const typing = !!inputType && ['insertText', 'deleteContentBackward', 'deleteContentForward', 'insertCompositionText'].includes(inputType);
    const merge = typing && previous && previous.inputType === inputType && now - previous.time < 700 && before.selectionStart === before.selectionEnd && previous.end === before.selectionStart;
    if (!merge) { undo.current.push({ ...before }); trimHistory(undo.current); }
    redo.current = []; current.current = next;
    lastTyping.current = typing ? { time: now, inputType: inputType!, end: next.selectionEnd } : null;
    if (!inputType) pending.current = next;
    onChange(next.value); setHistoryVersion(version => version + 1);
  };
  const changeHistory = (direction: 'undo' | 'redo') => {
    if (disabled || composing.current) return;
    rememberSelection(); const source = direction === 'undo' ? undo.current : redo.current;
    const target = direction === 'undo' ? redo.current : undo.current;
    const snapshot = source.pop(); if (!snapshot) return;
    target.push({ ...current.current }); trimHistory(target); restore(snapshot);
  };
  const format = (action: MarkdownAction) => {
    if (disabled || preview || composing.current) return;
    rememberSelection(); const selection = current.current;
    commit(applyMarkdownAction(selection.value, selection.selectionStart, selection.selectionEnd, action));
  };
  const insertImage = (markdown: string) => {
    rememberSelection();
    const selection = current.current;
    commit(insertMarkdownText(selection.value, selection.selectionStart, selection.selectionEnd, markdown));
    setPreview(false);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y' && !event.shiftKey) { event.preventDefault(); changeHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return; }
    const action = ({ b: 'bold', i: 'italic', k: 'link' } as Record<string, MarkdownAction>)[key];
    if (action && !event.shiftKey) { event.preventDefault(); format(action); }
  };
  const toolbarKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement); if (index < 0) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const showEdit = () => { setPreview(false); pending.current = current.current; setHistoryVersion(version => version + 1); };

  return <div className="markdown-editor">
    <div className="markdown-editor-heading"><label className="field-label" htmlFor={`${editorId}-source`}>正文 Markdown</label><div className="markdown-editor-tabs" role="tablist" aria-label="Markdown编辑模式">
      <button type="button" role="tab" id={`${editorId}-write-tab`} aria-controls={`${editorId}-write`} aria-selected={!preview} onClick={showEdit}>编辑</button>
      <button type="button" role="tab" id={`${editorId}-preview-tab`} aria-controls={`${editorId}-preview`} aria-selected={preview} onClick={() => { rememberSelection(); setPreview(true); }}>预览</button>
    </div></div>
    <div id={`${editorId}-write`} role="tabpanel" aria-labelledby={`${editorId}-write-tab`} hidden={preview}>
      <div className="markdown-editor-toolbar" role="toolbar" aria-label="Markdown格式工具" onKeyDown={toolbarKeys}>
        {tools.map(({ action, label: toolLabel, icon: Icon, shortcut, separated }) => <span className={`markdown-tool-item ${separated ? 'markdown-tool-separated' : ''}`} key={action}><button type="button" aria-label={toolLabel} title={`${toolLabel}${shortcut ? ` (${shortcut})` : ''}`} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => format(action)}><Icon size={17} /></button></span>)}
        <span className="markdown-tool-item markdown-tool-separated"><button type="button" aria-label="撤销" title="撤销 (Ctrl/⌘+Z)" disabled={disabled || !undo.current.length} onMouseDown={event => event.preventDefault()} onClick={() => changeHistory('undo')}><Undo2 size={17} /></button><button type="button" aria-label="重做" title="重做 (Ctrl/⌘+Shift+Z)" disabled={disabled || !redo.current.length} onMouseDown={event => event.preventDefault()} onClick={() => changeHistory('redo')}><Redo2 size={17} /></button></span>
      </div>
      <textarea id={`${editorId}-source`} ref={textarea} aria-label={label} aria-describedby={`${editorId}-help`} className="markdown-editor-source" rows={20} value={value} disabled={disabled} placeholder={placeholder} onSelect={rememberSelection} onClick={rememberSelection} onKeyDown={keyDown} onKeyUp={rememberSelection} onCompositionStart={() => { rememberSelection(); composing.current = true; }} onCompositionEnd={() => { composing.current = false; lastTyping.current = null; }} onChange={event => { const node = event.currentTarget; commit({ value: node.value, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd }, (event.nativeEvent as InputEvent).inputType || 'input'); }} />
      <div className="markdown-editor-attachment"><ImageUploadButton label="向资料上传图片" maxMiB={maxImageMiB} disabled={disabled} onInsert={insertImage} /><span>图片插入当前光标位置，也可直接粘贴 Markdown。</span></div>
    </div>
    <div id={`${editorId}-preview`} className="markdown-editor-preview markdown-preview" role="tabpanel" aria-labelledby={`${editorId}-preview-tab`} hidden={!preview}>{preview && (value.trim() ? <Markdown>{value}</Markdown> : <p className="markdown-editor-empty">还没有内容，切回编辑开始记录。</p>)}</div>
    <div className="markdown-editor-footer" id={`${editorId}-help`}><span>支持 Markdown · Ctrl/⌘ + B 粗体、I 斜体、K 链接</span><span>{value.length.toLocaleString('zh-CN')} 字符</span></div>
  </div>;
}
