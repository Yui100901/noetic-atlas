import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,Search} from 'lucide-react';
import {readSearchState,searchHref,searchReturnTarget} from './search-navigation';
import './search.css';

const isExamActive = () => document.body.classList.contains('exam-active');
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');

export function UnifiedSearchBar({ hash }: { hash: string }) {
  const [value, setValue] = useState(() => /^#\/search(?:\?|$)/.test(hash) ? readSearchState(hash).q : '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (/^#\/search(?:\?|$)/.test(hash)) setValue(readSearchState(hash).q); }, [hash]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && document.activeElement === input.current) { input.current?.blur(); return; }
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || isExamActive()) return;
      if (editable(event.target) && event.target !== input.current) return;
      event.preventDefault(); input.current?.focus(); input.current?.select();
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, []);
  return <form className="top-search unified-top-search" role="search" aria-label="全站统一搜索" onSubmit={event => {
    event.preventDefault(); if (isExamActive()) return;
    const current = readSearchState('#/search'); window.location.hash = searchHref({ ...current, q: value }); input.current?.blur();
  }}><Search size={15} aria-hidden="true" /><input ref={input} aria-label="全站搜索" type="search" maxLength={100} value={value} onChange={event => setValue(event.target.value)} placeholder="搜索全部内容…" autoComplete="off" /><kbd aria-hidden="true">Ctrl K</kbd><button aria-label="执行统一搜索" title="搜索全部内容" type="submit"><ArrowRight size={16} /></button></form>;
}

export function SearchReturnLink({ hash }: { hash: string }) {
  const target = searchReturnTarget(hash);
  return target ? <a className="button feature-entry search-return-link" href={target}><ArrowLeft size={15} />返回搜索结果</a> : null;
}

