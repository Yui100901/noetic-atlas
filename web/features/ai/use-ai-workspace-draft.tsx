import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {AiWorkspaceDraft,AiWorkspaceDraftKind} from '../../../shared/ai/workspace-drafts';
import {ApiError,idPath,localDate,request,send} from '../../shared/lib/api';
import {ErrorNotice,Loading,Modal,useApp} from '../../shared/ui/components';
import {useAiDraftSession} from './ai-workspace-draft-context';
import { ActionDropdown } from '../../shared/ui/action-dropdown';
import './ai-import-layout.css';

interface Options {kind:AiWorkspaceDraftKind;contextId?:string;state:Record<string,unknown>;restore(state:Record<string,unknown>):void;ready?:boolean;busy?:boolean;hasContent:boolean;compact?:boolean}
/** Drafts contain editor snapshots only: never file handles, credentials, or
 * in-flight model output. Serialized writes prevent an older save winning. */
export function useAiWorkspaceDraft(options:Options){
 const {bootstrap}=useApp(),session=useAiDraftSession(),delay=bootstrap.settings?.autosaveDebounceMs??1000;
 const [ready,setReady]=useState(false),[choices,setChoices]=useState<AiWorkspaceDraft[]|null>(null),[saving,setSaving]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(false),[savedAt,setSavedAt]=useState(''),[revision,setRevision]=useState(0);
 const latest=useRef(options);latest.current=options;
 const initial=useRef<Record<string,unknown>|null>(null),selected=useRef<AiWorkspaceDraft|null>(null),saved=useRef(''),enabled=useRef(false),finished=useRef(false),mounted=useRef(true),conflicted=useRef(false);
 if(!initial.current)initial.current=structuredClone(options.state);
 const operation=useRef<Promise<unknown>|null>(null),locked=useRef(false),serial=JSON.stringify(options.state);
 const dirty=()=>enabled.current&&!finished.current&&(!!selected.current||latest.current.hasContent)&&JSON.stringify(latest.current.state)!==saved.current;
 const write=async()=>{
  if(!enabled.current||finished.current)return selected.current;
  if(conflicted.current)throw new Error('草稿已在其他页面变化，请另存当前内容为新草稿。');
  if(!dirty())return selected.current;
  do{
   const state=JSON.parse(JSON.stringify(latest.current.state)) as Record<string,unknown>,key=JSON.stringify(state),previous=selected.current;
   const value=await send<AiWorkspaceDraft>(previous?`/api/ai/workspace-drafts/${idPath(previous.id)}`:'/api/ai/workspace-drafts',previous?'PUT':'POST',previous?{expectedUpdatedAt:previous.updatedAt,state}:{kind:latest.current.kind,contextId:latest.current.contextId||null,state});
   selected.current=value;saved.current=key;if(mounted.current)setSavedAt(value.updatedAt);
  }while(dirty());
  return selected.current;
 };
 const saveNow=():Promise<unknown>=>{
  if(operation.current)return operation.current;
  if(!dirty())return Promise.resolve(selected.current);
  if(mounted.current){setSaving(true);setError('');}
  const promise=write().catch(reason=>{
   if(reason instanceof ApiError&&(reason.status===404||reason.code==='AI_WORKSPACE_DRAFT_VERSION_CONFLICT')){conflicted.current=true;if(mounted.current)setConflict(true);}
   if(mounted.current)setError((reason as Error).message);throw reason;
  }).finally(()=>{operation.current=null;if(mounted.current)setSaving(false);});operation.current=promise;return promise;
 };
 const saveRef=useRef(saveNow);saveRef.current=saveNow;
 const query=()=>'/api/ai/workspace-drafts?'+new URLSearchParams({kind:options.kind,...(options.contextId?{contextId:options.contextId}:{})});
 useEffect(()=>{
  mounted.current=true;const controller=new AbortController();enabled.current=false;
  void request<AiWorkspaceDraft[]>(query(),{signal:controller.signal}).then(items=>{
   if(controller.signal.aborted)return;setError('');
   if(items.length)setChoices(items);else{saved.current=JSON.stringify(latest.current.state);enabled.current=true;setReady(true);}
  }).catch(reason=>{if(!controller.signal.aborted)setError((reason as Error).message);});
  return()=>{mounted.current=false;controller.abort();};
 },[options.kind,options.contextId,revision]);
 useEffect(()=>session?.register({dirty,busy:()=>!finished.current&&(!!latest.current.busy||locked.current),saving:()=>!!operation.current,save:()=>saveRef.current()}),[session]);
 useEffect(()=>{
  if(!ready||options.ready===false||conflict)return;
  if(finished.current&&serial!==saved.current)finished.current=false;
  const timer=setTimeout(()=>{void saveRef.current().catch(()=>undefined);},delay);
  return()=>clearTimeout(timer);
 },[serial,ready,options.ready,conflict,delay]);
 const reset=()=>{selected.current=null;finished.current=false;conflicted.current=false;setConflict(false);setError('');setSavedAt('');const state=structuredClone(initial.current!);saved.current=JSON.stringify(state);latest.current.restore(state);enabled.current=true;setChoices(null);setReady(true);};
 const resume=(value:AiWorkspaceDraft)=>{selected.current=value;finished.current=false;conflicted.current=false;setConflict(false);saved.current=JSON.stringify(value.state);latest.current.restore(structuredClone(value.state));setSavedAt(value.updatedAt);enabled.current=true;setChoices(null);setReady(true);};
 const clear=async()=>{await saveRef.current();const previous=selected.current;if(previous)await send(`/api/ai/workspace-drafts/${idPath(previous.id)}`,'DELETE',{expectedUpdatedAt:previous.updatedAt});selected.current=null;finished.current=true;saved.current=JSON.stringify(latest.current.state);setSavedAt('');};
 const runBusy=async<T,>(fn:()=>Promise<T>):Promise<T>=>{if(locked.current)throw new Error('当前操作尚未完成，请勿重复提交。');locked.current=true;try{await saveRef.current();return await fn();}finally{locked.current=false;}};
 const safely=async(fn:()=>Promise<unknown>)=>{try{await fn();}catch(reason){setError((reason as Error).message);}};
 const transition=async(action:()=>void|Promise<void>)=>{if(session)await session.transition(action);else{await saveRef.current();await action();}};
 const change=()=>transition(async()=>{setChoices(await request<AiWorkspaceDraft[]>(query()));});
 const newDraft=()=>transition(reset);
 const copy=async()=>{selected.current=null;conflicted.current=false;setConflict(false);saved.current='';await saveRef.current();};
 const disabled=!ready||saving||!!options.busy;
 const status=saving?'正在保存草稿…':dirty()?'有修改，等待自动保存…':savedAt?`草稿已保存 · ${localDate(savedAt)}`:ready?'草稿自动保存在本机':'正在检查工作台草稿…';
 const remove=()=>{if(confirm('删除当前草稿并清空本页输入？已创建题集、教材任务和已导入题目保留。'))void safely(async()=>{await transition(async()=>{await clear();reset();});});};
 const saveButton=<button type="button" className="button" disabled={disabled} onClick={()=>void safely(saveNow)}>保存草稿</button>;
 const controls:ReactNode=<section className={`ai-workspace-draft${options.compact?' ai-workspace-draft-compact':' notice info'}`} aria-label="AI工作台草稿" data-draft-kind={options.kind}>
  {options.compact?<div className="ai-draft-status-row"><div className="ai-draft-status"><strong>{status}</strong><small>仅保存到本机，不会自动运行AI或导入题目。</small></div><div className="action-row">{saveButton}<ActionDropdown label="草稿操作" disabled={disabled} items={[
   {id:'new',label:'新建草稿',onSelect:()=>void safely(newDraft)},
   {id:'switch',label:'切换草稿',onSelect:()=>void safely(change)},
   ...(selected.current?[{id:'remove',label:'删除当前草稿',danger:true,separatorBefore:true,onSelect:remove}]:[]),
  ]}/></div></div>:<div className="form-stack"><strong>{status}</strong><small>每种工作保留最近3份；教材内的编辑按任务分别保存。草稿不会自动调用AI、创建题集或导入题目。</small><div className="action-row">{saveButton}<button type="button" className="button" disabled={disabled} onClick={()=>void safely(newDraft)}>新建草稿</button><button type="button" className="button" disabled={disabled} onClick={()=>void safely(change)}>切换草稿</button>{selected.current&&<button type="button" className="button" disabled={saving||options.busy} onClick={remove}>删除当前草稿</button>}</div></div>}
  {conflict&&<div className="ai-draft-conflict"><button type="button" className="button primary" disabled={saving||options.busy} onClick={()=>void safely(copy)}>另存为新草稿</button></div>}
  {error&&<ErrorNotice message={error} retry={!ready?()=>setRevision(value=>value+1):undefined}/>} {!ready&&!choices&&!error&&<Loading text="正在读取草稿…"/>}
  {choices&&<Modal title="继续AI工作台草稿" onClose={()=>{if(enabled.current)setChoices(null);else reset();}}><div className="form-stack"><p>选择一份继续，或新建草稿。当前草稿会覆盖更新，其他草稿保留；每种工作保留最近3份。</p>{choices.map(value=><article className="ai-workspace-draft-choice" key={value.id}><div><strong>{String(value.state.title||value.state.sourceName||value.state.prompt||'未命名草稿').slice(0,100)}</strong><p className="muted">{localDate(value.updatedAt)}</p></div><button type="button" className="button" onClick={()=>void safely(()=>transition(()=>resume(value)))}>继续此草稿</button></article>)}<div className="action-row"><button type="button" className="button primary" onClick={()=>void safely(newDraft)}>新建草稿</button>{enabled.current&&<button className="button" onClick={()=>setChoices(null)}>取消</button>}</div></div></Modal>}
 </section>;
 return{ready:ready&&options.ready!==false,controls,saveNow,clear,runBusy};
}
