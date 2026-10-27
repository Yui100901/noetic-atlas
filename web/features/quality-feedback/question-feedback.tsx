import {useEffect} from 'react';
import {replaceHashRoute} from '../../shared/lib/navigation-guard';
import {Loading} from '../../shared/ui/components';

/** Historical links keep their identity, but management has one destination. */
export function QuestionFeedbackPage({questionId='',feedbackId=''}:{questionId?:string;feedbackId?:string}){
  useEffect(()=>{const params=new URLSearchParams();if(questionId)params.set('questionId',questionId);if(feedbackId)params.set('feedbackId',feedbackId);replaceHashRoute('#/content-quality'+(params.size?'?'+params:''));},[questionId,feedbackId]);
  return <Loading text="正在打开质量管理…"/>;
}
