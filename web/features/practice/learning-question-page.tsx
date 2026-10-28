import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ChevronLeft,ChevronRight} from 'lucide-react';
import type {ContextLearningQuestion} from '../../../shared/practice/context-learning';
import type {GlobalLearningQuestion} from '../../../shared/practice/global-learning';
import type {ReviewQueueItem} from '../../../shared/models/adaptive-review';
import type {Paged} from '../../../shared/utils/pagination';
import {request,useResource} from '../../shared/lib/api';
import {useNavigationGuard} from '../../shared/lib/navigation-guard';
import {Empty,ErrorNotice,Loading,PageHeader,useApp} from '../../shared/ui/components';
import {QuestionViewer,type QuestionViewerHandle} from '../questions/question-viewer';
import {QueueQuestionReader} from '../review-scheduler/review-queue-reader';
import {LearningOrigins,snapshotDescription} from './learning-origins';
import {learningListHref,learningQuestionsUrl,learningReaderHref,readLearningReader,type LearningReaderContext} from './learning-reader-navigation';
import './learning-question-page.css';
type Item=ContextLearningQuestion|GlobalLearningQuestion|ReviewQueueItem;
const itemKey=(value:Item)=>'key'in value?value.key:value.question.id;
const labels={wrong:'错题集',favorite:'收藏集',due:'待复习题集'};
export function LearningQuestionPage({params}:{params:URLSearchParams}){
 const location=readLearningReader(params);
 if(!location)return <Empty title="题目链接不完整" actions={<a className="button" href="#/papers">返回题集与练习</a>}/>;
 return <LearningReader key={params.toString()} context={location.context} selectedKey={location.itemKey}/>;
}
function LearningReader({context,selectedKey}:{context:LearningReaderContext;selectedKey:string}){
 const resource=useResource<Paged<Item>>(learningQuestionsUrl(context)),viewer=useRef<QuestionViewerHandle>(null),{toast}=useApp();
 const mounted=useRef(true),navigationRequest=useRef<AbortController|null>(null);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;navigationRequest.current?.abort();};},[]);
 const [pending,setPending]=useState(false),[error,setError]=useState('');
 useNavigationGuard({pending:()=>viewer.current?.hasUnsavedChanges()||false,saving:()=>viewer.current?.isSaving()||false,confirmLeave:()=>viewer.current?.confirmLeave()!==false,onBusy:()=>toast('学习记录正在保存，请稍后再离开。',true)});
 const index=resource.data?.items.findIndex(item=>itemKey(item)===selectedKey)??-1,selected=index>=0?resource.data!.items[index]:null;
 const position=(context.page-1)*context.pageSize+index,total=resource.data?.total||0;
 const title=selected?context.scope==='queue'?((selected as ReviewQueueItem).direction==='meaning_to_word'?((selected as ReviewQueueItem).practiceKind==='concept'?'看描述想概念':'看释义想词'):(selected as ReviewQueueItem).title):(selected as ContextLearningQuestion).question.title:'题目详情';
 async function move(delta:-1|1){if(pending||!resource.data||index<0)return;setError('');
  const adjacent=resource.data.items[index+delta];if(adjacent){window.location.hash=learningReaderHref(context,itemKey(adjacent));return;}
  const nextPage=context.page+delta;if(nextPage<1||nextPage>Math.ceil(total/context.pageSize))return;
  const controller=new AbortController();navigationRequest.current?.abort();navigationRequest.current=controller;
  setPending(true);try{const result=await request<Paged<Item>>(learningQuestionsUrl(context,nextPage),{signal:controller.signal});if(!mounted.current||controller.signal.aborted)return;const item=delta>0?result.items[0]:result.items.at(-1);if(!item)throw Error('题集内容已更新，请返回列表重新选择。');window.location.hash=learningReaderHref({...context,page:nextPage},itemKey(item));}catch(reason){if(mounted.current&&!controller.signal.aborted)setError((reason as Error).message);}finally{if(mounted.current&&navigationRequest.current===controller)setPending(false);}
 }
 const queueItem=context.scope==='queue'?selected as ReviewQueueItem:null;
 const globalItem=context.scope==='global'?selected as GlobalLearningQuestion:null;
 const questionItem=selected&&!queueItem?selected as ContextLearningQuestion:null;
 return <article className="learning-question-page" aria-label="特殊题集题目详情">
  <a className="back-link" href={learningListHref(context)}><ArrowLeft size={15}/>返回{context.scope==='queue'?'待复习题集':labels[context.kind]}</a>
  {resource.loading?<Loading text="正在读取题集中的题目…"/>:resource.error?<ErrorNotice message={resource.error} retry={resource.refresh}/>:!selected?<Empty title="该题目已不在当前题集范围中" description="收藏、错题或复习状态可能已更新，请返回列表重新选择。" actions={<a className="button primary" href={learningListHref(context)}>返回题集</a>}/>:<>
   <PageHeader eyebrow="题集阅读" title={title} description={context.scope==='global'?'系统汇总题集':context.scope==='queue'?'实时复习任务':context.scope==='quick'?'随机与单题自测': '本题集学习记录'} actions={<nav className="learning-reader-navigation" aria-label="特殊题集阅读导航"><button className="button" type="button" disabled={pending||position<=0} onClick={()=>void move(-1)}><ChevronLeft size={16}/>上一题</button><span role="status">第 {position+1} / {total} 题</span><button className="button" type="button" disabled={pending||position+1>=total} onClick={()=>void move(1)}>下一题<ChevronRight size={16}/></button></nav>}/>
   {error&&<ErrorNotice message={error}/>} {pending&&<Loading text="正在读取相邻页题目…"/>}
   {globalItem&&<section className="card learning-reader-origin"><p className="muted">{snapshotDescription(globalItem)}</p><LearningOrigins item={globalItem} kind={context.kind}/></section>}
   {questionItem&&<QuestionViewer ref={viewer} question={questionItem.question} presentation="page" contentSource={globalItem?.snapshotSource==='library'?'current':'snapshot'}/>}
   {queueItem&&<QueueQuestionReader item={queueItem} viewer={viewer}/>} 
  </>}
 </article>;
}
