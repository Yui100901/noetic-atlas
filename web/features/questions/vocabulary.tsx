import {href,qs,useResource} from '../../shared/lib/api';
import {Empty,ErrorNotice,Loading,useApp} from '../../shared/ui/components';
import {QuestionDetail} from './questions';
import type {QuestionStatus} from '../../../shared/models/types';

export function VocabularyReferencePage({word}:{word:string}){
  const {bootstrap}=useApp();
  const englishDomain=bootstrap.domains.find(d=>d.id==='english')||bootstrap.domains.find(d=>['英语','english'].includes(d.name.normalize('NFKC').trim().toLowerCase()));
  const {data,loading,error,refresh}=useResource<{word:string;matches:{id:string;title:string;status:QuestionStatus}[]}>('/api/vocabulary?'+qs({word}));
  if(loading)return <Loading/>;
  if(error)return <ErrorNotice message={error} retry={refresh}/>;
  if(!data?.matches.length)return <><button className="back-link text-button" type="button" onClick={()=>history.back()}>返回上一页</button><Empty title={`尚未收录英语词头“${word}”`} description="此引用按单词名称查找。导入相应英语词表后可在这里查阅，词卡保留原审核状态；专业术语的定义仍保存在原卡片中。" actions={<a className="button" href={'#/questions?'+qs({domainId:englishDomain?.id,search:word})}>在题库中搜索</a>}/></>;
  if(data.matches.length===1)return <><div className="notice info"><span>英文单词参考：{data.word}</span><button className="text-button" type="button" onClick={()=>history.back()}>返回上一页</button></div><QuestionDetail id={data.matches[0]!.id} showAnswer/></>;
  return <Empty title={`英语词头：${data.word}`} description="找到多份词卡，请选择要查阅的版本。" actions={<>{data.matches.map(q=><a className="button" key={q.id} href={href('questions',q.id)+'?answer=1'}>{q.title} · {q.status==='published'?'已发布':q.status==='pending'?'待审核':q.status==='draft'?'草稿':'已归档'}</a>)}</>}/>;
}
