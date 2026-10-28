import {useEffect,useRef,useState,type ReactNode,Children,isValidElement} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ArrowLeft,BookOpen,ChevronRight} from 'lucide-react';
import {Empty,ErrorNotice,Loading,PageHeader,SearchBox} from '../../shared/ui/components';
import {handbookLink,handbookSections,handbookSlug} from './handbook-model';
import './handbook.css';

const main='docs/使用说明书.md';
const imported=import.meta.glob(['../../../docs/使用说明书.md','../../../docs/题目字段与质量规则.md','../../../docs/题库内容与来源.md','../../../docs/术语概念卡.md','../../../docs/发布与部署.md','../../../docs/licenses/*.md','../../../docs/licenses/*.txt','../../../README.md','../../../API-CONTRACT.md'],{query:'?raw',import:'default'});
const documents=Object.fromEntries(Object.entries(imported).map(([key,loader])=>[key.replace('../../../',''),loader as ()=>Promise<string>]));
const available=new Set(Object.keys(documents));
const text=(nodes:ReactNode):string=>Children.toArray(nodes).map(node=>typeof node==='string'||typeof node==='number'?String(node):isValidElement<{children?:ReactNode}>(node)?text(node.props.children):'').join('');
export function HandbookPage(){
 const params=new URLSearchParams(window.location.hash.split('?')[1]),requested=params.get('doc')||main,document=available.has(requested)?requested:main;
 const [source,setSource]=useState(''),[error,setError]=useState(''),[search,setSearch]=useState(''),[pendingAnchor,setPendingAnchor]=useState(params.get('anchor')||'');const content=useRef<HTMLDivElement>(null);
 useEffect(()=>{let active=true;setSource('');setError('');void documents[document]().then(value=>{if(active)setSource(value);}).catch(()=>{if(active)setError('手册暂时无法读取，请刷新后重试。');});return()=>{active=false;};},[document]);
 const sections=handbookSections(source,document.split('/').at(-1)!.replace(/\.(md|txt)$/,'')),query=search.trim().toLowerCase(),visible=sections.filter(section=>!query||(section.title+'\n'+section.body).toLowerCase().includes(query));
 useEffect(()=>{if(!source||!pendingAnchor)return;const frame=requestAnimationFrame(()=>{content.current?.querySelector<HTMLElement>(`[id="${CSS.escape(pendingAnchor)}"]`)?.scrollIntoView({block:'start',behavior:'smooth'});setPendingAnchor('');});return()=>cancelAnimationFrame(frame);},[source,pendingAnchor,search]);
 function jump(anchor:string){setSearch('');setPendingAnchor(anchor);}
 const title=document===main?'用户使用手册':document.split('/').at(-1)!.replace(/\.(md|txt)$/,'');
 const markdown=(body:string)=><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url=>handbookLink(document,url,available).kind==='disabled'?'':url} components={{
  a:({href,children})=>{const link=handbookLink(document,href||'',available);if(link.kind==='disabled')return <span>{children}</span>;
   if(link.kind==='external')return <a href={link.href} target="_blank" rel="noopener noreferrer">{children}</a>;
   if(link.kind==='anchor')return <a href={'#'+link.anchor} onClick={event=>{event.preventDefault();jump(link.anchor);}}>{children}</a>;
   return <a href={'#/help?'+new URLSearchParams({doc:link.document,...(link.anchor?{anchor:link.anchor}:{})})}>{children}</a>;},
  h1:({children})=><h1 id={handbookSlug(text(children))}>{children}</h1>,h2:({children})=><h2 id={handbookSlug(text(children))}>{children}</h2>,h3:({children})=><h3 id={handbookSlug(text(children))}>{children}</h3>,h4:({children})=><h4 id={handbookSlug(text(children))}>{children}</h4>,
  img:({alt})=><span>{alt||'文档插图'}</span>,table:({children})=><div className="table-scroll"><table>{children}</table></div>,
 }}>{body}</ReactMarkdown>;
 return <article className="handbook-page" aria-label="应用内使用手册"><a className="back-link" href="#/"><ArrowLeft size={15}/>返回知识总览</a><PageHeader eyebrow="USER GUIDE" title={title} description="随应用内置，离线也能查看。按目录阅读，或搜索需要的操作。" actions={document!==main?<a className="button" href="#/help"><BookOpen size={16}/>返回使用手册</a>:undefined}/>
  {error?<ErrorNotice message={error}/>:!source?<Loading text="正在打开内置手册…"/>:<><SearchBox value={search} onChange={setSearch} placeholder="搜索手册内容"/><p className="muted" role="status">{query?`找到${visible.length}个相关章节`:`共${sections.length}个章节`}</p><div className="handbook-layout"><nav className="card handbook-directory" aria-label="手册目录">{sections.map(section=><button className="text-button" type="button" key={section.id} onClick={()=>jump(section.id)}>{section.title}<ChevronRight size={13}/></button>)}</nav><div className="handbook-content" ref={content}>{sections.length?(visible.length?visible.map(section=><section className="card markdown" key={section.id}>{markdown(section.body)}</section>):<Empty title="没有找到相关章节" description="试试题目、题集、备份或AI等关键词。"/>):<section className="card markdown">{markdown(source)}</section>}</div></div></>}
 </article>;
}
