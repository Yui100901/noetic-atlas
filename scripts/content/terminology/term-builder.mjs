/** Original bilingual terminology cards, with optional portable lexical references. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'../../..'),stamp='2026-10-23T00:00:00.000Z';
export const TERMINOLOGY_TAG={id:'method-terminology',name:'术语概念',domainId:null,kind:'method',color:'#856142',description:'从中文名、英文全称或缩写回忆概念，再辨析实例、边界与相近术语。'};
const definitions=[
  {id:'computer-science',name:'计算机与软件',description:'当前已整理的计算机知识与面试准备；可新增其他学习领域',sortOrder:0},
  {id:'english',name:'英语',description:'开放词汇资料与原创语法练习；本轮新增均待审核',sortOrder:10},
  {id:'japanese',name:'日语',description:'日语词汇、读音、语法与表达；等级为学习参考，不是官方JLPT固定大纲',sortOrder:20},
  {id:'chinese',name:'语文',description:'成语释义、拼音、典故与阅读表达；来源缺失项保留明确标记。',sortOrder:30},
  {id:'driving',name:'驾驶与道路交通',description:'中国大陆驾驶理论、现行法规条款学习与原创模拟题；不是官方完整考试题库。',sortOrder:4},
  {id:'chemistry',name:'化学',description:'日常、工业、食品与材料中的化学物质、性质、反应和用途。',sortOrder:5},
  {id:'medicine-pharmacy',name:'医学与药学',description:'药理与药品信息学习，区分化学身份、临床用途和用药安全。',sortOrder:6},
];
const norm=s=>s.normalize('NFKC').trim().toLocaleLowerCase('en');
const stop=new Set('a an the of and or for to in on at by with from as is via per'.split(' '));
// Explicit word-family hints, never an unrestricted stemmer: e.g. "class"
// must not become "clas", and a common-word sense is not a technical definition.
const wordFamily=new Map(Object.entries({learning:'learn',training:'train',validation:'validate',supervised:'supervise',unsupervised:'supervise',overfitting:'fit',regularization:'regular',leakage:'leak',tokenizer:'token',embedding:'embed',prefill:'fill',decoding:'code',reranking:'rank',grounding:'ground',retrieval:'retrieve',augmented:'augment',generation:'generate',adaptation:'adapt',compilation:'compile',inheritance:'inherit',injection:'inject',dependency:'depend',binding:'bind',linking:'link',parsing:'parse',typing:'type',evaluation:'evaluate',classification:'classify',sampling:'sample',clustering:'cluster'}));
export function lexicalReferences(english,vocabulary){
  const candidate=[english,...english.match(/[A-Za-z]+(?:['-][A-Za-z]+)*/g)||[]];
  const seen=new Set(),references=[];
  for(const original of [...new Set(candidate.map(norm))]){
    if(stop.has(original)||original.length<2)continue;
    const matched=vocabulary.has(original)?original:wordFamily.get(original);
    if(!matched||!vocabulary.has(matched)||seen.has(matched))continue;seen.add(matched);
    const word=vocabulary.get(matched);references.push({word,url:'#/vocabulary/'+encodeURIComponent(word),...(original!==matched?{original,relation:'word-family'}:{relation:'exact'})});
  }
  return references;
}
export function createTermPack({packId,title,domainIds,idPrefix,categoryPrefix,groups},vocabulary=new Map()){
  if(!/^[a-z0-9-]+$/.test(packId)||!groups?.length)throw Error('Invalid terminology pack');
  const domains=domainIds.map(id=>{const found=definitions.find(d=>d.id===id);if(!found)throw Error('Unknown domain '+id);return found;});
  const categories=[],tags=[TERMINOLOGY_TAG],questions=[],entries=[],keys=new Set(),heads=new Set(),groupIds=new Set();
  for(const domainId of domainIds)categories.push({id:'terms-root-'+domainId,domainId,name:'术语与概念',parentId:null,sortOrder:90,description:'双语名称、常用缩写、概念定义、实例和边界辨析。'});
  for(const [groupIndex,group]of groups.entries()){
    const domainId=group.domainId||domainIds[0];if(!domainIds.includes(domainId)||groupIds.has(group.id))throw Error('Invalid terminology group '+group.id);groupIds.add(group.id);
    const categoryId=categoryPrefix+'-'+group.id,tagId=categoryPrefix+'-topic-'+group.id;
    categories.push({id:categoryId,domainId,name:group.name,parentId:'terms-root-'+domainId,sortOrder:groupIndex,description:group.description||group.name});
    tags.push({id:tagId,name:group.name,domainId,kind:'topic',color:'#5264db',description:'术语主题：'+group.name+'。'});
    for(const row of group.rows){
      for(const field of ['key','term','english','definition','example','distinction','pitfall','followup','followupAnswer'])if(typeof row[field]!=='string'||!row[field].trim())throw Error('Missing '+field+' for '+row.term);
      if(!/^[a-z0-9-]+$/.test(row.key)||keys.has(row.key)||heads.has(domainId+':'+norm(row.term)))throw Error('Duplicate terminology identity '+row.key);
      if(row.definition.trim().length<40)throw Error('Definition too short: '+row.term);
      if(!row.sources?.length||row.sources.some(s=>!s.label||!/^https:\/\//.test(s.url)))throw Error('Missing primary source '+row.term);
      keys.add(row.key);heads.add(domainId+':'+norm(row.term));
      const aliases=[...new Set(row.aliases||[])],id=idPrefix+row.key,related=lexicalReferences(row.english,vocabulary);
      const name=row.term+'（'+row.english+'）'+(aliases.length?' · '+aliases.join(' / '):'');
      const lexical=related.length?related.map(ref=>`[${ref.word}](${ref.url})`+(ref.original?`（${ref.original} 的词族参考）`:'')).join(' · '):'无';
      const question={id,title:'术语：'+name,type:'short_answer',stemMarkdown:`**${name}**\n\n请解释该术语的具体含义，并给出一个实例，说明它与相近概念的区别及适用边界。`,answerMarkdown:`**概念定义**：${row.definition}`,explanationMarkdown:`### 名称与缩写\n\n中文：${row.term}\n\n英文名称或全称：${row.english}\n\n别名或常用缩写：${aliases.length?aliases.join('、'):'无'}\n\n### 具体例子\n\n${row.example}\n\n### 相近概念辨析\n\n${row.distinction}\n\n### 常见误解与适用边界\n\n${row.pitfall}\n\n### 追问与参考回答\n\n**追问**：${row.followup}\n\n**回答**：${row.followupAnswer}\n\n### 英文单词参考\n\n${lexical}`,options:[],correctAnswers:[],difficulty:row.difficulty??1,depth:row.depth??2,frequency:row.frequency??0,frequencyScope:'术语基础复习；计算机频次为专题编辑建议，其他领域未统计频次',frequencyBasis:'不是招聘或考试命中率统计，不以缩写长度代表难度。',collection:'general',status:'pending',categoryIds:[categoryId],tagIds:[TERMINOLOGY_TAG.id,tagId],sourceRefs:row.sources,sourceDocument:null,sourceAnchor:null,createdAt:stamp,updatedAt:stamp};
      if(question.title.length>300)throw Error('Term title too long '+row.key);
      questions.push(question);entries.push({id,key:row.key,term:row.term,english:row.english,aliases,domainId,group:group.id,lexicalReferences:related});
    }
  }
  const pack={schemaVersion:1,generatedAt:stamp,domains,categories,tags,questions,documents:[],papers:[],assets:[],questionBanks:[{id:'bank-'+packId,name:title,description:'按中文术语、英文全称及常用缩写复习概念，英语单词采用可迁移引用，不复制词卡。',questionIds:questions.map(q=>q.id),createdAt:stamp,updatedAt:stamp}]};
  return {pack,entries};
}
export async function buildTermPack(options){
  let vocabulary=new Map();
  try{const source=JSON.parse(await readFile(join(root,'data/content-packs/english.json'),'utf8'));vocabulary=new Map(source.questions.filter(q=>q.id.startsWith('EN-V-')).map(q=>[norm(q.title),q.title]));}catch(error){if(error.code!=='ENOENT')throw error;}
  const {pack,entries}=createTermPack(options,vocabulary),output=JSON.stringify(pack,null,2)+'\n',sha256=createHash('sha256').update(output).digest('hex');
  const source={id:options.packId,title:options.title,generatedAt:stamp,output:'data/content-packs/'+options.packId+'.json',sha256,questions:pack.questions.length,reviewStatus:'pending',collection:'general',typeCounts:{short_answer:pack.questions.length},license:'Project-authored factual educational summaries; primary references retain their own rights.',sourcePolicy:'中文定义、例子、辨析与追问独立编写；规范和官方资料供核验与延伸阅读，不复制受限词典或商业题库。',duplicatePolicy:'同包主名及key唯一；术语卡与面试场景题属于不同学习视角，不据同一概念强行删除既有题。缩写可一词多义，保留全称和领域限定。',lexicalPolicy:'优先精确匹配已有英文词头，有限的显式词族关系另行标注；链接按词头解析，不依赖接收方题号，不复制或自动批准单词卡。词族或普通词义不作为技术定义。',lexicalReferenceQuestions:entries.filter(e=>e.lexicalReferences.length).length,lexicalReferences:entries.reduce((n,e)=>n+e.lexicalReferences.length,0),groups:options.groups.map(g=>({id:g.id,name:g.name,domainId:g.domainId||options.domainIds[0],questions:g.rows.length})),sources:[...new Map(pack.questions.flatMap(q=>q.sourceRefs).map(s=>[s.url,s])).values()],entries};
  await mkdir(join(root,'data/content-packs'),{recursive:true});await mkdir(join(root,'data/content-sources'),{recursive:true});
  await writeFile(join(root,'data/content-packs',options.packId+'.json'),output);await writeFile(join(root,'data/content-sources',options.packId+'.json'),JSON.stringify(source,null,2)+'\n');
  console.log(JSON.stringify({id:options.packId,questions:pack.questions.length,groups:source.groups,lexicalReferenceQuestions:source.lexicalReferenceQuestions,sha256},null,2));return {pack,source};
}
