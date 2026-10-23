import { useEffect, useRef, useState } from 'react';
import type { PaperDraft, PaperDraftState } from '../../../shared/practice/paper-drafts';
import { idPath, localDate, request, send } from '../../shared/lib/api';
import { ErrorNotice, Loading, Modal } from '../../shared/ui/components';

export function usePaperDraft({context,state,restore,delay,maximum,ready=true}:{context:string;state:PaperDraftState;restore:(state:PaperDraftState)=>void;delay:number;maximum:number;ready?:boolean}) {
  const [choices,setChoices]=useState<PaperDraft[]|null>(null),[initialized,setInitialized]=useState(false),[error,setError]=useState(''),[saving,setSaving]=useState(false),[savedAt,setSavedAt]=useState('');
  const selected=useRef<PaperDraft|null>(null),snapshot=useRef(state),baseline=useRef(''),disabled=useRef(false),chain=useRef(Promise.resolve()),restoreRef=useRef(restore),alive=useRef(true);
  snapshot.current=state;restoreRef.current=restore;
  const serial=JSON.stringify(state);
  useEffect(()=>{
    if(!ready)return; const controller=new AbortController();
    void Promise.resolve().then(()=>{
    if(controller.signal.aborted)return;
    return request<PaperDraft[]>(`/api/paper-drafts?context=${encodeURIComponent(context)}`,{signal:controller.signal}).then(items=>{
      if(controller.signal.aborted)return;
      baseline.current=JSON.stringify(snapshot.current);
      if(items.length)setChoices(items); else setInitialized(true);
    }).catch(err=>{if(!controller.signal.aborted)setError(err.message);});
    });
    return ()=>controller.abort();
  },[context,ready]);
  const meaningful=(value:PaperDraftState)=>Boolean(value.title.trim()||value.description.trim()||value.questionIds.length);
  const save=()=>{
    const run=async()=>{
      const current=snapshot.current,key=JSON.stringify(current);
      if(disabled.current||!meaningful(current)||key===baseline.current)return;
      if(alive.current){setSaving(true);setError('');}
      try {
        const previous=selected.current;
        const draft=await send<PaperDraft>(previous?`/api/paper-drafts/${idPath(previous.id)}`:'/api/paper-drafts',previous?'PUT':'POST',previous?{expectedUpdatedAt:previous.updatedAt,state:current}:{context,state:current});
        selected.current=draft;baseline.current=key;
        if(alive.current)setSavedAt(draft.updatedAt);
      } catch(err) {if(alive.current)setError((err as Error).message);throw err;} finally{if(alive.current)setSaving(false);}
    };
    chain.current=chain.current.catch(()=>{}).then(run);return chain.current;
  };
  const saveRef=useRef(save);saveRef.current=save;
  useEffect(()=>{if(!initialized)return;const timer=setTimeout(()=>{void saveRef.current().catch(()=>{});},delay);return()=>clearTimeout(timer);},[serial,initialized,delay]);
  useEffect(()=>{
    alive.current=true;
    const before=(event:BeforeUnloadEvent)=>{if(!disabled.current&&initialized&&meaningful(snapshot.current)&&JSON.stringify(snapshot.current)!==baseline.current){event.preventDefault();event.returnValue='';void saveRef.current().catch(()=>{});}};
    window.addEventListener('beforeunload',before);
    return()=>{alive.current=false;window.removeEventListener('beforeunload',before);if(initialized)void saveRef.current().catch(()=>{});};
  },[initialized]);
  const completed=async()=>{disabled.current=true;await chain.current.catch(()=>{});if(selected.current){await send(`/api/paper-drafts/${idPath(selected.current.id)}`,'DELETE');selected.current=null;}};
  const choose=(draft?:PaperDraft)=>{
    if(draft){selected.current=draft;baseline.current=JSON.stringify(draft.state);restoreRef.current(draft.state);setSavedAt(draft.updatedAt);}
    else {selected.current=null;baseline.current=JSON.stringify(snapshot.current);}
    setChoices(null);setInitialized(true);setError('');
  };
  const remove=async(draft:PaperDraft)=>{if(!confirm(`删除组卷草稿「${draft.state.title||'未命名组卷'}」？`))return;setSaving(true);setError('');try{await send(`/api/paper-drafts/${idPath(draft.id)}`,'DELETE');setChoices(old=>old?.filter(item=>item.id!==draft.id)||[]);}catch(err){setError((err as Error).message);}finally{setSaving(false);}};
  const picker=choices&&<Modal title="继续组卷草稿" onClose={()=>{if(!saving)choose();}}><p>发现{choices.length}份组卷草稿（最多保留最近{maximum}份）。选择后会继续覆盖同一份草稿，也可以从当前空白表单新建。</p>{error&&<ErrorNotice message={error}/>}<div className="authoring-draft-choices">{choices.map(draft=><div key={draft.id} className="authoring-draft-choice"><button type="button" className="button" disabled={saving} onClick={()=>choose(draft)}><strong>{draft.state.title||'未命名组卷'}</strong><span>{draft.state.questionIds.length}道已选题 · {localDate(draft.updatedAt)}</span></button><button type="button" className="text-button danger-text" disabled={saving} onClick={()=>void remove(draft)}>删除此草稿</button></div>)}</div><button type="button" className="button primary" disabled={saving} onClick={()=>choose()}>重新组卷</button></Modal>;
  return { initialized, picker, completed, saveNow:save, status:<div className="authoring-draft-status" role="status">{error?<ErrorNotice message={`组卷草稿未保存：${error}`} retry={()=>{if(initialized)void save().catch(()=>{});else window.location.reload();}}/>:!initialized&&!choices?<Loading text="正在检查组卷草稿…"/>:saving?'正在保存组卷草稿…':savedAt?`组卷草稿已保存 ${localDate(savedAt)}`:`组卷过程自动保存，最多保留${maximum}份最近草稿。`}</div> };
}
