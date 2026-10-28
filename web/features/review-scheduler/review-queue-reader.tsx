import type {RefObject} from 'react';
import type {Question} from '../../../shared/models/types';
import type {ReviewQueueItem} from '../../../shared/models/adaptive-review';
import {idPath,useResource} from '../../shared/lib/api';
import {ErrorNotice,Loading} from '../../shared/ui/components';
import {QuestionContent} from '../../shared/ui/content-notices';
import {GroupStudyTools,QuestionViewer,type QuestionSnapshot,type QuestionViewerHandle} from '../questions/question-viewer';
export function QueueQuestionReader({item,viewer}:{item:ReviewQueueItem;viewer:RefObject<QuestionViewerHandle|null>}){
 const resource=useResource<Question>(`/api/questions/${idPath(item.questionId)}`);
 if(resource.loading)return <Loading text="正在读取复习题目…"/>;
 if(resource.error||!resource.data)return <ErrorNotice message={resource.error||'原题已不可用，请返回并刷新队列'} retry={resource.refresh}/>;
 const question=resource.data;
 if(question.type==='group'&&!item.partId)return <><p className="notice info">这是一项旧整组复习安排。请选择小题分别核对和记录回忆，公共材料继续保留。</p><section className="card"><QuestionContent questionType={question.type}>{question.stemMarkdown}</QuestionContent></section><GroupStudyTools ref={viewer} question={question}/></>;
 const part=item.partId?question.parts?.find(value=>value.id===item.partId):undefined;
 if(item.partId&&!part)return <ErrorNotice message="该小题已被修改或删除，请返回后刷新队列"/>;
 const snapshot:QuestionSnapshot=part?{...question,...part,id:`${question.id}::${part.id}`,parts:undefined,sourceQuestionId:question.id,partId:part.id,groupTitle:question.title,groupStemMarkdown:question.stemMarkdown}:question;
 return <QuestionViewer ref={viewer} question={snapshot} contentSource="current" reviewDirection={item.direction} presentation="page"/>;
}
