import {createContext, memo, useContext, useMemo, useRef, useState, type ReactNode} from 'react';
import {collectContentNotices, extractContentNotices} from '../../../shared/questions/content-notices';
import {Markdown} from './components';
import './content-notices.css';

const NoticeScope = createContext(false);
type Notices = ReturnType<typeof collectContentNotices>;

function ContentNotices({notices}:{notices:Notices}) {
  const [opened,setOpened]=useState(false);
  if(!notices.length)return null;
  return <details className="content-notices" onToggle={event=>setOpened(event.currentTarget.open)}><summary>学习说明与资料许可 <span className="muted">{notices.length} 项</span></summary>{opened&&<div className="content-notices-body">{notices.map((notice,index)=><section key={index}><h3>{notice.title}</h3><Markdown>{notice.markdown}</Markdown></section>)}</div>}</details>;
}

/** Only question content opts into audited notice extraction. Ordinary notes,
 * documents, and knowledge about licensing continue to use Markdown directly. */
export const QuestionContent = memo(function QuestionContent({children}:{children:string}) {
  const scoped=useContext(NoticeScope);
  const content=useMemo(()=>extractContentNotices(children),[children]);
  return <>{content.markdown.trim()&&<Markdown>{content.markdown}</Markdown>}{!scoped&&<ContentNotices notices={content.notices}/>}</>;
});

/** A scope owns one deduplicated disclosure, including notices in answers that
 * may currently be collapsed. The raw question/attempt snapshots stay intact. */
export function SourceNoticeScope({contents,children}:{contents:string[];children:ReactNode}) {
  const parent=useContext(NoticeScope);
  const cache=useRef<{contents:string[];notices:Notices}|null>(null);
  // Answer clocks can rerender every second with a new array of unchanged
  // strings. Avoid reparsing all question snapshots on each clock tick.
  if(!cache.current||contents.length!==cache.current.contents.length||contents.some((value,index)=>value!==cache.current!.contents[index]))cache.current={contents:[...contents],notices:collectContentNotices(contents)};
  return <NoticeScope.Provider value={true}>{children}{!parent&&<ContentNotices notices={cache.current.notices}/>}</NoticeScope.Provider>;
}

interface QuestionNoticeContent {
  stemMarkdown?:string;answerMarkdown?:string;explanationMarkdown?:string;groupStemMarkdown?:string;
  options?:{text:string}[];parts?:QuestionNoticeContent[];
}
export function questionNoticeContents(question:QuestionNoticeContent):string[] {
  return [question.groupStemMarkdown,question.stemMarkdown,question.answerMarkdown,question.explanationMarkdown,...(question.options||[]).map(option=>option.text),...(question.parts||[]).flatMap(questionNoticeContents)].filter((value):value is string=>typeof value==='string'&&!!value);
}
