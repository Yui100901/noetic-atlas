import {lazyPage} from '../lib/lazy-page';
import { Children, cloneElement, createContext, isValidElement, memo, useContext, useEffect, useId, useRef, useState, Suspense, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronRight, LoaderCircle, Search, X } from 'lucide-react';
import type { Bootstrap, Category, Question } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import { PAGE_SIZES, usePagination } from '../lib/pagination';
import './authoring.css';
import {lockModalScroll,modalFocusTargets} from './modal-behavior';

export const AppContext = createContext<{ bootstrap: Bootstrap; reload: () => void; toast: (message: string, error?: boolean) => void } | null>(null);
export function useApp() { const context = useContext(AppContext); if (!context) throw new Error('应用尚未就绪'); return context; }
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{actions&&<div className="header-actions">{actions}</div>}</header>;
}
export function Loading({ text = '正在读取本地资料…' }: { text?: string }) { return <div className="loading" role="status"><LoaderCircle size={19} className="spin" />{text}</div>; }
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) { return <div className="notice error" role="alert"><AlertCircle size={18} /><span>{message}</span>{retry && <button className="text-button" type="button" onClick={retry}>重新加载</button>}</div>; }
export function Empty({ title = '这里还没有内容', description, actions }: { title?: string; description?: string; actions?: ReactNode }) { return <div className="empty"><span className="empty-mark">∅</span><h3>{title}</h3>{description && <p>{description}</p>}{actions}</div>; }
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null); const dialogRef = useRef<HTMLDivElement>(null);
  const latestClose=useRef(onClose);latestClose.current=onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement; closeRef.current?.focus();const unlock=lockModalScroll(document.body);
    const onKey = (event: KeyboardEvent) => {
      const dialog=dialogRef.current;if(!dialog||event.defaultPrevented||Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1)!==dialog)return;
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();latestClose.current();}
      if(event.key==='Tab'){
        const controls=modalFocusTargets(dialog),first=controls[0],last=controls.at(-1);
        if(!controls.includes(document.activeElement as HTMLElement)||event.shiftKey&&document.activeElement===first||!event.shiftKey&&document.activeElement===last){event.preventDefault();(event.shiftKey?last:first)?.focus();}
      }
    };
    document.addEventListener('keydown', onKey); return () => { unlock();document.removeEventListener('keydown', onKey); if(previous?.isConnected)previous.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={dialogRef}><div className="modal-heading"><h2>{title}</h2><button ref={closeRef} type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></div>{children}</div></div>;
}
export function SearchBox({ value, onChange, placeholder = '搜索题目、内容或题号' }: { value: string; onChange: (value: string) => void; placeholder?: string }) { return <label className="search-box"><Search size={18} /><span className="sr-only">{placeholder}</span><input type="search" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} /></label>; }
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const fieldId = useId(); const labelId = `${fieldId}-label`; const hintId = `${fieldId}-hint`;
  type ControlProps = { id?: string; 'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string };
  const control = Children.toArray(children).find(child => isValidElement(child) && typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type));
  const controlId = isValidElement<ControlProps>(control) ? control.props.id || fieldId : undefined;
  const labelledChildren = Children.map(children, child => {
    if (!isValidElement<ControlProps>(child) || typeof child.type !== 'string' || !['input', 'select', 'textarea'].includes(child.type)) return child;
    return cloneElement(child, {
      id: child.props.id || fieldId,
      'aria-labelledby': child.props['aria-labelledby'] || (child.props['aria-label'] ? undefined : labelId),
      'aria-describedby': [child.props['aria-describedby'], hint ? hintId : ''].filter(Boolean).join(' ') || undefined,
    });
  });
  return <div className={`field ${className}`}><label className="field-label" id={labelId} htmlFor={controlId}>{label}</label>{labelledChildren}{hint && <small id={hintId}>{hint}</small>}</div>;
}
export function MultiSelect({ label, options, values, onChange, placeholder = '筛选…' }: { label: string; options: { id: string; name: string }[]; values: string[]; onChange: (values: string[]) => void; placeholder?: string }) {
  const [search, setSearch] = useState('');
  const paging=usePagination(options.filter(option=>option.name.toLowerCase().includes(search.toLowerCase())),search);
  return <div className="multiselect"><div className="field-label">{label} <span className="muted">{values.length ? `已选 ${values.length} · 跨页保留` : '可多选'}</span></div><input aria-label={`搜索${label}`} className="small-input" placeholder={placeholder} value={search} onChange={event => setSearch(event.target.value)} /><div className="multi-options">{paging.items.map(option => <label key={option.id} className={`check-pill ${values.includes(option.id) ? 'checked' : ''}`}><input type="checkbox" checked={values.includes(option.id)} onChange={() => onChange(values.includes(option.id) ? values.filter(id => id !== option.id) : [...values, option.id])} />{option.name}</label>)}{!paging.total && <span className="muted">{options.length?'没有匹配项目':'请先在分类管理中添加'}</span>}</div>{paging.total>10&&<Pagination {...paging} label={label}/> }</div>;
}
export function CategoryOptions({ categories, parentId = null, depth = 0, domainId }: { categories: Category[]; parentId?: string | null; depth?: number; domainId?: string }) {
  if (depth > categories.length) return null;
  return <>{categories.filter(category => category.parentId === parentId && (!domainId || category.domainId === domainId)).map(category => <CategoryOptionBranch key={category.id} category={category} categories={categories} depth={depth} domainId={domainId} />)}</>;
}
function CategoryOptionBranch({ category, categories, depth, domainId }: { category: Category; categories: Category[]; depth: number; domainId?: string }) { return <><option value={category.id}>{'　'.repeat(depth)}{depth ? '↳ ' : ''}{category.name}</option><CategoryOptions categories={categories} parentId={category.id} depth={depth + 1} domainId={domainId} /></>; }
export function QuestionMeta({ question, compact = false }: { question: Pick<Question, 'id' | 'type' | 'difficulty' | 'depth' | 'frequency' | 'collection'>; compact?: boolean }) {
  return <div className="question-meta">{!compact && <code>{question.id}</code>}<span className={`type-badge type-${question.type}`}>{typeLabels[question.type]}</span><span>D{question.difficulty} / L{question.depth}</span><span className={question.frequency === 3 ? 'frequency-high' : ''}>{question.frequency ? `F${question.frequency} · ${question.frequency === 3 ? '常见' : question.frequency === 2 ? '较少见' : '拓展'}` : '未标常见度'}</span>{question.collection === 'personal' && <span className="badge personal">个人专项</span>}</div>;
}
export function Tags({ ids, max = 6 }: { ids: string[]; max?: number }) { const { bootstrap } = useApp(); return <div className="tags">{ids.slice(0, max).map(id => { const tag = bootstrap.tags.find(item => item.id === id); return tag ? <span className="tag" key={id}>{tag.name}</span> : null; })}{ids.length > max && <span className="tag">+{ids.length - max}</span>}</div>; }
export function Pagination({ page, pageSize, total, onPage, onPageSize, label='列表' }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; onPageSize?: (size:number)=>void; label?:string }) { const pages = Math.max(1, Math.ceil(total / pageSize)); return <nav className="pagination" aria-label={`${label}分页`}><span>共 {total.toLocaleString()} 条 · 第 {Math.min(page,pages)} / {pages} 页</span><div>{onPageSize&&<label className="page-size-label">每页 <select aria-label={`${label}每页数量`} value={pageSize} onChange={event=>onPageSize(Number(event.target.value))}>{[...new Set([...PAGE_SIZES,pageSize])].sort((a,b)=>a-b).map(size=><option key={size} value={size}>{size} 条</option>)}</select></label>}<button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button><button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页 <ChevronRight size={14} /></button></div></nav>; }
// The shell uses lightweight controls only; parse Markdown when content first appears.
const MarkdownRenderer=lazyPage(()=>import('./markdown-renderer'));
export const Markdown=memo(function Markdown({children}:{children:string}){return <Suspense fallback={<div className="markdown" role="status">正在排版内容…</div>}><MarkdownRenderer>{children}</MarkdownRenderer></Suspense>;});
export function SaveButton({ busy, children = '保存', disabled = false }: { busy: boolean; children?: ReactNode; disabled?: boolean }) { return <button className="button primary" type="submit" disabled={busy || disabled}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? '正在保存…' : children}</button>; }
