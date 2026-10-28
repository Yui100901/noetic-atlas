import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
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
  readOnly?: boolean;
  rows?: number;
  compact?: boolean;
  required?: boolean;
  maxLength?: number;
  hint?: string;
  heading?: string;
  imageUploadLabel?: string;
  allowImages?: boolean;
  className?: string;
  textareaClassName?: string;
  previewRenderer?(value: string): ReactNode;
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
export function MarkdownEditor({ value, onChange, label = '资料正文', placeholder = '## 我想理解的问题', maxImageMiB, disabled = false, readOnly = false, rows, compact = false, required = false, maxLength, hint, heading = '正文 Markdown', imageUploadLabel = '向资料上传图片', allowImages = true, className = '', textareaClassName = '', previewRenderer }: MarkdownEditorProps) {
  const editorId = useId(), textarea = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false), [historyVersion, setHistoryVersion] = useState(0), [toolsOpen, setToolsOpen] = useState(!compact), [message, setMessage] = useState('');
  const mounted = useRef(true), epoch = useRef(0), invalidFrame = useRef<number | undefined>(undefined);
  const editingDisabled = disabled || readOnly;
  const rowCount = Math.max(2, Math.min(100, rows ?? (compact ? 5 : 20))), sized = rows !== undefined || compact;
  const current = useRef<Snapshot>({ value, selectionStart: 0, selectionEnd: 0 });
  const undo = useRef<Snapshot[]>([]), redo = useRef<Snapshot[]>([]);
  const pending = useRef<Selection | null>(null), composing = useRef(false);
  const lastTyping = useRef<{ time: number; inputType: string; end: number } | null>(null);
  const previousValue = useRef(value);
  // An external file import or another loaded document starts its own history.
  if (value !== previousValue.current) {
    previousValue.current = value;
    if (value !== current.current.value) {
      epoch.current++;
      current.current = { value, selectionStart: Math.min(current.current.selectionStart, value.length), selectionEnd: Math.min(current.current.selectionEnd, value.length) };
      undo.current = []; redo.current = []; lastTyping.current = null; pending.current = null;
    }
  }
  const rememberSelection = () => {
    const node = textarea.current;
    if (node) current.current = { ...current.current, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd };
  };
  useLayoutEffect(() => {
    if (!preview && !disabled && pending.current && textarea.current) {
      const range = pending.current; pending.current = null;
      textarea.current.focus({ preventScroll: true }); textarea.current.setSelectionRange(range.selectionStart, range.selectionEnd);
    }
  }, [value, preview, historyVersion, disabled]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (invalidFrame.current !== undefined) cancelAnimationFrame(invalidFrame.current); }; }, []);
  useEffect(() => setMessage(''), [value]);
  useLayoutEffect(() => {
    textarea.current?.setCustomValidity(maxLength !== undefined && value.length > maxLength ? `内容超过${maxLength.toLocaleString('zh-CN')}字符，请精简后保存。` : '');
  }, [value, maxLength]);
  const allowed = (next: Snapshot) => {
    if (maxLength !== undefined && next.value.length > maxLength && next.value.length >= current.current.value.length) {
      setMessage(`本次修改会超过${maxLength.toLocaleString('zh-CN')}字符，未应用，请精简后再试。`);
      return false;
    }
    setMessage(''); return true;
  };
  const restore = (snapshot: Snapshot) => {
    current.current = snapshot; pending.current = snapshot; lastTyping.current = null;
    onChange(snapshot.value); setHistoryVersion(version => version + 1);
  };
  const commit = (next: Snapshot, inputType?: string) => {
    if (editingDisabled || !allowed(next)) return;
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
    if (editingDisabled || composing.current) return;
    rememberSelection(); const source = direction === 'undo' ? undo.current : redo.current;
    const target = direction === 'undo' ? redo.current : undo.current;
    const snapshot = source.at(-1); if (!snapshot || !allowed(snapshot)) return; source.pop();
    target.push({ ...current.current }); trimHistory(target); restore(snapshot);
  };
  const format = (action: MarkdownAction) => {
    if (editingDisabled || preview || composing.current) return;
    rememberSelection(); const selection = current.current;
    commit(applyMarkdownAction(selection.value, selection.selectionStart, selection.selectionEnd, action));
  };
  const insertImage = (markdown: string) => {
    if (!mounted.current || editingDisabled || !allowImages) return;
    rememberSelection();
    const selection = current.current;
    commit(insertMarkdownText(selection.value, selection.selectionStart, selection.selectionEnd, markdown));
    setPreview(false);
  };
  // ImageUploadButton may finish using a callback from the render that started
  // the upload. Use the latest text/caret; discard insertion after an external
  // document/AI replacement instead of writing that result into another draft.
  const imageInsert = useRef(insertImage); imageInsert.current = insertImage;
  const uploadEpoch = epoch.current;
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

  return <div className={`markdown-editor ${compact ? 'markdown-editor-compact' : ''} ${sized ? 'markdown-editor-sized' : ''} ${className}`} role="group" aria-label={`${label}编辑器`} style={{ '--markdown-editor-rows': rowCount } as CSSProperties}>
    <div className="markdown-editor-heading"><label className="field-label" htmlFor={`${editorId}-source`}>{heading}{required && <span aria-hidden="true"> *</span>}</label><div className="markdown-editor-heading-actions">{compact && <button type="button" className="markdown-editor-tools-toggle" aria-label="格式工具" aria-expanded={toolsOpen} aria-controls={`${editorId}-tools`} onClick={() => { if (preview) { showEdit(); setToolsOpen(true); } else setToolsOpen(open => !open); }}>格式工具</button>}<div className="markdown-editor-tabs" role="tablist" aria-label="Markdown编辑模式">
      <button type="button" role="tab" id={`${editorId}-write-tab`} aria-controls={`${editorId}-write`} aria-selected={!preview} onClick={showEdit}>编辑</button>
      <button type="button" role="tab" id={`${editorId}-preview-tab`} aria-controls={`${editorId}-preview`} aria-selected={preview} onClick={() => { rememberSelection(); setPreview(true); }}>预览</button>
    </div></div></div>
    {hint && <p className="markdown-editor-hint" id={`${editorId}-hint`}>{hint}</p>}
    <div id={`${editorId}-write`} role="tabpanel" aria-labelledby={`${editorId}-write-tab`} hidden={preview}>
      <div id={`${editorId}-tools`} className="markdown-editor-toolbar" role="toolbar" aria-label="Markdown格式工具" hidden={compact && !toolsOpen} onKeyDown={toolbarKeys}>
        {tools.map(({ action, label: toolLabel, icon: Icon, shortcut, separated }) => <span className={`markdown-tool-item ${separated ? 'markdown-tool-separated' : ''}`} key={action}><button type="button" aria-label={toolLabel} title={`${toolLabel}${shortcut ? ` (${shortcut})` : ''}`} disabled={editingDisabled} onMouseDown={event => event.preventDefault()} onClick={() => format(action)}><Icon size={17} /></button></span>)}
        <span className="markdown-tool-item markdown-tool-separated"><button type="button" aria-label="撤销" title="撤销 (Ctrl/⌘+Z)" disabled={editingDisabled || !undo.current.length} onMouseDown={event => event.preventDefault()} onClick={() => changeHistory('undo')}><Undo2 size={17} /></button><button type="button" aria-label="重做" title="重做 (Ctrl/⌘+Shift+Z)" disabled={editingDisabled || !redo.current.length} onMouseDown={event => event.preventDefault()} onClick={() => changeHistory('redo')}><Redo2 size={17} /></button></span>
      </div>
      <textarea id={`${editorId}-source`} ref={textarea} aria-label={label} aria-describedby={[`${editorId}-help`, hint && `${editorId}-hint`, message && `${editorId}-message`].filter(Boolean).join(' ')} className={`markdown-editor-source ${textareaClassName}`} rows={rowCount} value={value} disabled={disabled} readOnly={readOnly} required={required} maxLength={maxLength} placeholder={placeholder} onInvalid={event => {
        const node = event.currentTarget; setMessage(node.validity.valueMissing ? `请填写${label}。` : node.validationMessage);
        if (preview) { event.preventDefault(); flushSync(() => setPreview(false)); node.focus(); invalidFrame.current = requestAnimationFrame(() => { if (mounted.current && node.isConnected) node.reportValidity(); }); }
      }} onSelect={rememberSelection} onClick={rememberSelection} onKeyDown={keyDown} onKeyUp={rememberSelection} onCompositionStart={() => { rememberSelection(); composing.current = true; }} onCompositionEnd={() => { composing.current = false; lastTyping.current = null; }} onChange={event => { const node = event.currentTarget; commit({ value: node.value, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd }, (event.nativeEvent as InputEvent).inputType || 'input'); }} />
      {allowImages && <div className="markdown-editor-attachment" hidden={compact && !toolsOpen}><ImageUploadButton label={imageUploadLabel} maxMiB={maxImageMiB} disabled={editingDisabled} onInsert={markdown => {
        if (!mounted.current) return;
        if (uploadEpoch !== epoch.current) { setMessage('内容已切换，已上传的图片未插入当前字段，请在需要的位置重新插入。'); return; }
        imageInsert.current(markdown);
      }} /><span>图片插入当前光标位置，也可直接粘贴 Markdown。</span></div>}
    </div>
    <div id={`${editorId}-preview`} className="markdown-editor-preview markdown-preview" role="tabpanel" aria-labelledby={`${editorId}-preview-tab`} hidden={!preview}>{preview && (value.trim() ? previewRenderer ? previewRenderer(value) : <Markdown>{value}</Markdown> : <p className="markdown-editor-empty">还没有内容，切回编辑开始记录。</p>)}</div>
    {message && <p className="markdown-editor-message" role="alert" id={`${editorId}-message`}>{message}</p>}
    <div className="markdown-editor-footer" id={`${editorId}-help`}><span>{compact ? 'Markdown · Ctrl/⌘ + B / I / K' : '支持 Markdown · Ctrl/⌘ + B 粗体、I 斜体、K 链接'}</span><span>{value.length.toLocaleString('zh-CN')}{maxLength !== undefined && ` / ${maxLength.toLocaleString('zh-CN')}`} 字符</span></div>
  </div>;
}
