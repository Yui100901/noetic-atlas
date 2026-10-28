import type {Question} from '../../../shared/models/types';
import {questionStemMarkdown} from '../../../shared/questions/blank-markers';
import {idPath} from '../../shared/lib/api';
import {Markdown} from '../../shared/ui/components';

const text=(value:unknown)=>typeof value==='string'?value:'';
const list=(value:unknown):any[]=>Array.isArray(value)?value:[];
const answer=(value:string)=>value==='true'?'正确':value==='false'?'错误':value;
function SourceBody({value}:{value:any}){
  if(!value||typeof value!=='object')return <p className="notice">该部分内容结构不完整，请在编辑页核对。</p>;
  const keys=list(value.correctAnswers).filter(v=>typeof v==='string');
  return <><Markdown>{questionStemMarkdown({type:text(value.type),stemMarkdown:text(value.stemMarkdown)})}</Markdown>
    {list(value.options).map((option,index)=>option&&typeof option==='object'&&<div className="quality-source-option" key={index}><strong>{text(option.key)}.</strong><Markdown>{text(option.text)}</Markdown></div>)}
    <h4>参考答案{keys.length?' · '+keys.map(answer).join('、'):''}</h4>
    {list(value.blanks).map((blank,index)=>blank&&typeof blank==='object'&&<p key={index}><strong>{index+1}. {text(blank.label)||'填空'}</strong>：{list(blank.answers).filter(v=>typeof v==='string').join(' / ')||'未填写可接受答案'}</p>)}
    {text(value.answerMarkdown)?<Markdown>{value.answerMarkdown}</Markdown>:!keys.length&&!list(value.blanks).length&&<p className="muted">未填写独立参考答案。</p>}
    {text(value.explanationMarkdown)&&<><h4>解析</h4><Markdown>{value.explanationMarkdown}</Markdown></>}
  </>;
}
/** Shared, defensive evidence view. Broken structures remain inspectable. */
export function QualitySource({question,partId,actions=true}:{question:Pick<Question,'id'>&Partial<Question>;partId?:string;actions?:boolean}){
  const parts=list(question.parts),part=partId?parts.find(p=>p&&p.id===partId):undefined;
  return <div className="quality-source">
    {partId?<><h4>公共材料</h4><Markdown>{text(question.stemMarkdown)}</Markdown>{part?<section><h4>{text(part.title)||partId}</h4><SourceBody value={part}/></section>:<p className="notice">指定小题已不存在，反馈和历史证据仍保留。</p>}</>:<><SourceBody value={question}/>{parts.map((value,index)=><section key={value?.id||index}><h4>小题 {index+1} · {text(value?.title)}</h4><SourceBody value={value}/></section>)}</>}
    {actions&&<div className="quality-actions"><a className="button" href={`#/questions/${idPath(question.id)}`} target="_blank" rel="noopener noreferrer">打开原题（新窗口）</a><a className="button" href={`#/questions/${idPath(question.id)}/edit`} target="_blank" rel="noopener noreferrer">编辑原题（新窗口）</a></div>}
  </div>;
}
