import {createContext,useContext,useEffect,useRef,type ReactNode} from 'react';
import {useNavigationGuard} from '../../shared/lib/navigation-guard';
import {useApp} from '../../shared/ui/components';

export interface AiDraftParticipant {dirty():boolean;busy():boolean;saving():boolean;save():Promise<unknown>}
type Transition=()=>void|Promise<void>;
const Context=createContext<{register(value:AiDraftParticipant):()=>void;transition(action:Transition):Promise<void>}|null>(null);
export function useAiDraftSession(){return useContext(Context);}
/** One guard owns the workspace, including the textbook and its open task. */
export function AiWorkspaceDraftSession({children}:{children:ReactNode}){
 const {toast}=useApp(),participants=useRef(new Set<AiDraftParticipant>()),transitioning=useRef(false);
 const busy=()=>[...participants.current].some(item=>item.busy());
 const saving=()=>[...participants.current].some(item=>item.saving());
 const dirty=()=>[...participants.current].some(item=>item.dirty());
 const save=async()=>{for(const item of participants.current)await item.save();};
 const transition=async(action:Transition)=>{
  if(transitioning.current)return;
  if(busy()){toast('当前处理或草稿保存尚未完成，请完成或取消后再切换。',true);return;}
  transitioning.current=true;
  try{await save();await action();}catch(reason){toast('草稿未保存，已保留当前页面：'+(reason as Error).message,true);}finally{transitioning.current=false;}
 };
 const latest=useRef({transition,dirty,busy});latest.current={transition,dirty,busy};
 // Save before following ordinary links. Back/Forward uses the synchronous
 // router guard below; it stays on this page until a pending save completes.
 useEffect(()=>{
  const click=(event:MouseEvent)=>{
   if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
   const link=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href]'):null;
   if(!link||link.target==='_blank'||link.hasAttribute('download'))return;
   const target=new URL(link.href,location.href);
   if(target.href===location.href||target.origin===location.origin&&target.pathname===location.pathname&&target.search===location.search&&!target.hash.startsWith('#/'))return;
   if(!latest.current.dirty()&&!latest.current.busy())return;
   event.preventDefault();event.stopImmediatePropagation();void latest.current.transition(()=>{location.href=target.href;});
  };
  document.addEventListener('click',click,true);return()=>document.removeEventListener('click',click,true);
 },[]);
 useNavigationGuard({pending:dirty,saving:()=>busy()||saving()||transitioning.current,confirmLeave:()=>{void transition(()=>toast('草稿已保存，可以返回或离开。'));return false;},onBusy:()=>toast('处理或草稿保存中，请稍后再离开。',true)});
 const session=useRef({register(value:AiDraftParticipant){participants.current.add(value);return()=>{participants.current.delete(value);};},transition:(action:Transition)=>latest.current.transition(action)});
 return <Context.Provider value={session.current}>{children}</Context.Provider>;
}
