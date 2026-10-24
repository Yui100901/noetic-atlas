/** Original Chinese foundation questions. Writes source packs only, never the user database. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const stamp='2026-10-24T00:00:00Z';
export const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
export const sharedTags=[
  {id:'atlas-expansion-concept',name:'概念与术语',domainId:null,kind:'method',color:'#856142',description:'理解定义、含义、例子与适用边界。'},
  {id:'atlas-expansion-case',name:'研究与历史案例',domainId:null,kind:'method',color:'#856142',description:'辨析研究设计或历史事件的机制、证据与局限。'},
  {id:'atlas-expansion-application',name:'情境应用',domainId:null,kind:'method',color:'#856142',description:'根据具体条件应用概念，辨析选项与常见误解。'},
];
export function makeCatalog({domain,prefix,categories,sources}){
  const questions=[],counts={};
  const categoryIds=categories.map(([key,name])=>({id:`${prefix}-fnd-${key}`,domainId:domain.id,name,parentId:null,description:`${domain.name}：${name}基础与应用`,sortOrder:categories.findIndex(row=>row[0]===key)+1}));
  const topicTags=categories.map(([key,name])=>({id:`${prefix}-topic-${key}`,domainId:domain.id,name,kind:'topic',color:domain.color||'#626bc8',description:`${domain.name}的${name}内容。`}));
  function add(type,category,title,stem,answer,explanation,sourceKeys,extra={}){
    const seq=counts[type]=(counts[type]||0)+1;
    const kind={short_answer:'SA',single_choice:'SC',multiple_choice:'MC',true_false:'TF',fill_blank:'FB'}[type];
    const keys=Array.isArray(sourceKeys)?sourceKeys:[sourceKeys];
    if(!categories.some(([id])=>id===category))throw new Error(`Unknown category: ${category}`);
    if(keys.some(key=>!sources[key]))throw new Error(`Unknown source: ${keys}`);
    const {method='application',difficulty=2,depth=2,...rest}=extra;
    const record={id:`${prefix.toUpperCase()}-FND-${kind}-${String(seq).padStart(3,'0')}`,title,type,stemMarkdown:stem,answerMarkdown:answer,explanationMarkdown:explanation,options:[],correctAnswers:[],difficulty,depth,frequency:0,frequencyScope:'通识与基础课程学习',frequencyBasis:'未统计课程或考试命中率',collection:'general',status:'pending',categoryIds:[`${prefix}-fnd-${category}`],tagIds:[`${prefix}-topic-${category}`,`atlas-expansion-${method}`],sourceRefs:keys.map(key=>({label:sources[key].title,url:sources[key].url})),sourceDocument:null,sourceAnchor:null,createdAt:stamp,updatedAt:stamp,...rest};
    // Only choice labels in this catalog use standalone A–D in explanations.
    // Rotate labels as well as answers to avoid a systematic correct-position cue.
    if(type==='single_choice'||type==='multiple_choice'){
      const offset=type==='single_choice'?((seq-1)%4-'ABCD'.indexOf(record.correctAnswers[0])+4)%4:(seq-1)%4;
      const map=Object.fromEntries([...'ABCD'].map((letter,index)=>[letter,'ABCD'[(index+offset)%4]]));
      record.options=record.options.map(option=>({...option,key:map[option.key]})).sort((a,b)=>a.key.localeCompare(b.key));
      record.correctAnswers=record.correctAnswers.map(key=>map[key]).sort();
      record.explanationMarkdown=record.explanationMarkdown.replace(/\b[ABCD]\b/g,letter=>map[letter]);
      record.answerMarkdown=record.correctAnswers.map(key=>`${key}：${record.options.find(option=>option.key===key).text}`).join('；');
    }
    questions.push(record);
  }
  return {questions,counts,
    short:(category,title,stem,answer,explanation,sourceKeys,extra={})=>add('short_answer',category,title,stem,answer,explanation,sourceKeys,{method:'concept',...extra}),
    single:(category,title,stem,options,correct,explanation,sourceKeys,extra={})=>add('single_choice',category,title,stem,`${correct}：${options['ABCD'.indexOf(correct)]}`,explanation,sourceKeys,{...extra,options:options.map((text,index)=>({key:'ABCD'[index],text})),correctAnswers:[correct]}),
    multiple:(category,title,stem,options,correct,explanation,sourceKeys,extra={})=>add('multiple_choice',category,title,stem,correct.join('、'),explanation,sourceKeys,{...extra,options:options.map((text,index)=>({key:'ABCD'[index],text})),correctAnswers:correct}),
    tf:(category,title,stem,correct,explanation,sourceKeys,extra={})=>add('true_false',category,title,stem,correct?'正确。':'错误。',explanation,sourceKeys,{difficulty:1,depth:1,...extra,correctAnswers:[String(correct)]}),
    blank:(category,title,stem,answers,explanation,sourceKeys,extra={})=>add('fill_blank',category,title,stem,answers[0],explanation,sourceKeys,{difficulty:1,depth:1,...extra,blanks:[{id:'answer',label:'填写概念或数值',answers,caseSensitive:false,trim:true}]}),
    pack:()=>({schemaVersion:1,generatedAt:stamp,domains:[{id:domain.id,name:domain.name,description:domain.description,sortOrder:domain.sortOrder}],categories:categoryIds,tags:[...sharedTags,...topicTags],questions,documents:[],papers:[],assets:[],questionBanks:[]}),
  };
}
export async function saveCatalog(name,title,catalog,sources,notes=[]){
  const pack=catalog.pack();
  if(pack.questions.length<120)throw new Error(`${name} needs at least 120 questions`);
  for(const type of ['short_answer','single_choice','multiple_choice','true_false','fill_blank'])if(catalog.counts[type]<({short_answer:60,single_choice:15,multiple_choice:15,true_false:15,fill_blank:15})[type])throw new Error(`${name} insufficient count: ${type}/${catalog.counts[type]}`);
  const json=JSON.stringify(pack,null,2)+'\n';
  const output=resolve(root,'data/content-packs',name+'.json');
  const manifest=resolve(root,'data/content-sources',name+'.json');
  await mkdir(dirname(output),{recursive:true});await mkdir(dirname(manifest),{recursive:true});
  await writeFile(output,json,'utf8');
  const used=new Set(pack.questions.flatMap(q=>q.sourceRefs.map(s=>s.url)));
  await writeFile(manifest,JSON.stringify({schemaVersion:1,title,generatedAt:stamp,contentPack:`../content-packs/${name}.json`,sha256:createHash('sha256').update(json).digest('hex'),questionCount:pack.questions.length,typeCounts:catalog.counts,reviewStatus:'pending',authorship:'题干、选项、情境、答案和解释为原创中文教学整理。仅将所列资料用于核对公开事实与学术定义；未复制其题库、插图、正文或原题。',licensePolicy:'新增原创文字可随项目题库分享；不为引用资料再授权。来源页面及原论文各自保留版权。OpenStax当前站点含CC BY-NC-SA及AI使用条款，不能据旧版本宣传为无限制商用；本包不包含其正文、原题、图片或翻译段落。引用不表示来源机构认可本项目。',notes,sources:Object.values(sources).filter(s=>used.has(s.url)).map(s=>({...s,checkedAt:'2026-10-24',usage:'事实核对与延伸阅读链接；未嵌入来源正文或图片。',rights:s.url.includes('openstax.org')?'OpenStax页面及第三方内容保留各自权利；当前许可请见书籍前言。':'原始发布机构或作者保留权利；链接引用，不转载。'}))},null,2)+'\n','utf8');
  console.log(`${name}: ${pack.questions.length} questions; ${JSON.stringify(catalog.counts)}`);
}
