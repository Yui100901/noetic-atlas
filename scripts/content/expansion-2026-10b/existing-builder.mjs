/** Source-backed, independently authored concepts and misconception practice.
 * Writes pending generic packages only; never opens the working database. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { GLOBAL_KNOWLEDGE_TAGS } from '../../../shared/questions/knowledge-tags.ts';
import { conceptPromptIsSafe } from '../../../shared/questions/concept.ts';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const STAMP = '2026-10-26T15:00:00.000Z';
const digest = value => createHash('sha256').update(value).digest('hex');
export const normalizeIdentity = value => String(value).normalize('NFKC').toLowerCase().replace(/^术语[：:]\s*/,'').split(/[（(]/u)[0].replace(/[\s“”"'。:：]/g,'').trim();
const normalStem = value => String(value).normalize('NFKC').replace(/\s+/g,' ').trim();
export const refs = (label,url) => [{label,url}];
export const conceptRows = (group,text,sources) => text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
  const [term,definition,distinction,aliases] = line.split('|').map(value=>value.trim());
  if(!term||!definition||!distinction)throw new Error('Incomplete concept '+line);
  return {group,term,definition,distinction,...(aliases?{aliases:aliases.split(' / ')}:{}),...(sources?{sources}:{})};
});
export const trueFalseRows = (group,text,sources) => text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
  const [stem,correct,explanation]=line.split('|').map(value=>value.trim());
  if(!stem||!['true','false'].includes(correct)||!explanation)throw new Error('Incomplete judgment '+line);
  return {group,type:'true_false',stem,correct:correct==='true',explanation,...(sources?{sources}:{})};
});
/** Pipe fields: stem | correct option | distractor 1 | distractor 2 | distractor 3 | explanation. */
export const singleChoiceRows = (group,text,sources) => text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
  const [stem,answer,a,b,c,explanation]=line.split('|').map(value=>value.trim());
  if(!stem||!answer||!a||!b||!c||!explanation)throw new Error('Incomplete choice '+line);
  return {group,type:'single_choice',stem,options:[answer,a,b,c],correct:'A',explanation,...(sources?{sources}:{})};
});
/** Each row is one blank: stem with underline | accepted answers separated by slash | explanation. */
export const fillRows = (group,text,sources) => text.trim().split(/\r?\n/).filter(Boolean).map(line=>{
  const [stem,answer,explanation]=line.split('|').map(value=>value.trim());
  if(!stem?.includes('____')||!answer||!explanation)throw new Error('Incomplete blank '+line);
  const answers=answer.split(' / ');
  return {group,type:'fill_blank',stem,answer:answers.join('；'),blanks:[{id:'blank-1',label:'第1空',answers,caseSensitive:false,trim:true}],explanation,...(sources?{sources}:{})};
});
export async function inventory(prefix='knowledge-expansion-20261026') {
  const questions=new Map(),domains=new Map(),categories=new Map();
  const files=[join(ROOT,'data/seed.json'),...(await readdir(join(ROOT,'data/content-packs'))).filter(name=>name.endsWith('.json')&&!name.startsWith(prefix+'-')).sort().map(name=>join(ROOT,'data/content-packs',name))];
  for(const file of files){const pack=JSON.parse(await readFile(file,'utf8'));for(const domain of pack.domains||[])domains.set(domain.id,domain);for(const c of pack.categories||[])categories.set(c.id,c);for(const q of pack.questions||[])if(!questions.has(q.id))questions.set(q.id,q);}
  const titles=new Map(),stems=new Map();
  for(const q of questions.values())for(const d of new Set(q.categoryIds.map(id=>categories.get(id)?.domainId).filter(Boolean))){
    if(!titles.has(d))titles.set(d,new Set());if(!stems.has(d))stems.set(d,new Set());
    titles.get(d).add(normalizeIdentity(q.title));stems.get(d).add(normalStem(q.stemMarkdown));
    if(q.concept)titles.get(d).add(normalizeIdentity(q.concept.term));
  }
  return {questions,domains,categories,titles,stems};
}
export async function buildCatalogs(catalogs,{prefix='knowledge-expansion-20261026'}={}) {
  const existing=await inventory(prefix),reports=[],skipped=[];
  for(const catalog of catalogs){
    const domain=existing.domains.get(catalog.domainId)||catalog.domain;
    if(!domain||domain.id!==catalog.domainId)throw new Error('Unknown domain '+catalog.domainId);
    const id=prefix+'-'+catalog.key;
    const categories=Object.entries(catalog.groups).map(([key,group],index)=>({id:id+'-'+key,domainId:domain.id,parentId:null,name:group.name,description:group.description||'常见概念、易错理解与基础应用，保留逐题参考。',sortOrder:300+index}));
    const methods=GLOBAL_KNOWLEDGE_TAGS.filter(tag=>['method-concept','method-application','method-comparison'].includes(tag.id));
    const tags=[...methods,...categories.map(c=>({id:c.id+'-topic',name:c.name,domainId:domain.id,kind:'topic',color:'#526D83',description:catalog.title+'：'+c.name}))];
    const questions=[],seenTitles=new Set(),seenStems=new Set();
    function sourceFor(row){const group=catalog.groups[row.group];if(!group)throw new Error('Unknown group '+row.group);const sources=row.sources||group.sources;if(!sources?.length)throw new Error('Missing references '+(row.term||row.stem));for(const ref of sources){const url=new URL(ref.url);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid source');}return [...new Map(sources.map(ref=>[ref.url,ref])).values()];}
    function add(row,fields,method){
      const title=fields.title,stem=fields.stemMarkdown,key=normalizeIdentity(title),body=normalStem(stem);
      if(seenTitles.has(key)||seenStems.has(body))throw new Error('Duplicate authored item '+catalog.key+'/'+title);
      seenTitles.add(key);seenStems.add(body);
      if((fields.concept&&existing.titles.get(domain.id)?.has(key))||existing.stems.get(domain.id)?.has(body)){skipped.push({domainId:domain.id,title,reason:'existing normalized concept title or identical question stem'});return;}
      questions.push({id:`EXP26B-${catalog.key.toUpperCase()}-${digest(title+'\n'+stem).slice(0,14)}`,type:'short_answer',title,stemMarkdown:stem,options:[],correctAnswers:[],difficulty:row.difficulty||2,depth:row.depth||2,frequency:0,frequencyScope:'常用知识与易错理解；未统计考试频率',frequencyBasis:'依据公开一手教材、官方资料和稳定基础知识选编。',collection:'general',status:'pending',categoryIds:[id+'-'+row.group],tagIds:[method,id+'-'+row.group+'-topic',...(row.comparison?['method-comparison']:[])],sourceRefs:sourceFor(row),sourceDocument:null,sourceAnchor:null,createdAt:STAMP,updatedAt:STAMP,...fields});
    }
    for(const row of catalog.concepts||[]){const concept={term:row.term.trim(),meaningPrompt:row.definition.trim(),acceptedAnswers:[...new Set([row.term.trim(),...(row.aliases||[])])].filter(Boolean)};if(!conceptPromptIsSafe(concept))throw new Error('Unsafe concept prompt '+row.term);add(row,{title:row.term.trim(),stemMarkdown:row.term.trim(),answerMarkdown:row.definition.trim()+'。',explanationMarkdown:'### 理解与易错辨析\n\n'+row.distinction,concept},'method-concept');}
    for(const row of catalog.questions||[]){
      const title=row.title||row.stem.replace(/[\n`*]/g,' ').slice(0,110),type=row.type;
      if(!row.explanation?.trim())throw new Error('Missing explanation '+title);
      let options=[],correctAnswers=[];
      if(type==='single_choice'||type==='multiple_choice'){
        if(!Array.isArray(row.options)||row.options.length<2||row.options.length>6)throw new Error('Invalid choice '+title);
        const letters='ABCDEF',offset=parseInt(digest(row.stem).slice(0,4),16)%row.options.length;
        const keys=Object.fromEntries(row.options.map((_,index)=>[letters[index],letters[(index+offset)%row.options.length]]));
        options=row.options.map((text,index)=>({key:keys[letters[index]],text})).sort((a,b)=>a.key.localeCompare(b.key));correctAnswers=(Array.isArray(row.correct)?row.correct:[row.correct]).map(key=>keys[key]).sort();
        if(correctAnswers.some(key=>!key)||type==='single_choice'&&correctAnswers.length!==1||type==='multiple_choice'&&correctAnswers.length<2)throw new Error('Invalid answer '+title);
      }else if(type==='true_false'){if(typeof row.correct!=='boolean')throw new Error('Invalid judgment '+title);correctAnswers=[String(row.correct)];}
      const answerMarkdown=row.answer|| (type==='true_false'?(row.correct?'正确':'错误'):correctAnswers.map(key=>key+'：'+options.find(option=>option.key===key).text).join('；'));
      add(row,{title,type,stemMarkdown:row.stem,answerMarkdown,explanationMarkdown:row.explanation,options,correctAnswers,...(row.blanks?{blanks:row.blanks}:{})},'method-application');
    }
    if(!questions.length)continue;
    const pack={schemaVersion:1,generatedAt:STAMP,domains:[domain],categories,tags,questions,documents:[],papers:[],assets:[],questionBanks:[]};
    if(catalog.enrichPack)await catalog.enrichPack(pack);
    const serialized=JSON.stringify(pack,null,2)+'\n';
    const report={id,title:catalog.title,domainId:domain.id,generatedAt:STAMP,verifiedAt:'2026-10-26',questions:questions.length,concepts:questions.filter(q=>q.concept).length,typeCounts:Object.fromEntries([...new Set(questions.map(q=>q.type))].map(type=>[type,questions.filter(q=>q.type===type).length])),status:'pending',sha256:digest(serialized),sources:[...new Map(questions.flatMap(q=>q.sourceRefs).map(ref=>[ref.url,ref])).values()],authorship:'中文定义、题干、干扰项及辨析独立撰写；引用一手资料核对基础事实，不复制来源原题、图片或大段正文。',scope:catalog.scope||'常见概念和基础应用；不等同于完整考纲或专家逐题鉴定。'};
    await mkdir(join(ROOT,'data/content-packs'),{recursive:true});await mkdir(join(ROOT,'data/content-sources'),{recursive:true});
    await writeFile(join(ROOT,'data/content-packs',id+'.json'),serialized);await writeFile(join(ROOT,'data/content-sources',id+'.json'),JSON.stringify(report,null,2)+'\n');reports.push(report);
  }
  return {reports,skipped,total:reports.reduce((n,r)=>n+r.questions,0),concepts:reports.reduce((n,r)=>n+r.concepts,0)};
}
