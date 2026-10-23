import type { Category, Question, Tag } from '../models/types.js';

export const OUTDATED_TAG = 'common-possibly-outdated';
export const OBSOLETE_TAG = 'common-confirmed-outdated';
export const GLOBAL_KNOWLEDGE_TAGS: Tag[] = [
  {id:OUTDATED_TAG,name:'可能失效或过时',domainId:null,kind:'custom',color:'#ad632b',description:'历史来源或依赖版本、地区、监管信息，需按标注范围核验；不表示整题所有知识都错误。'},
  {id:OBSOLETE_TAG,name:'已确认含失效内容',domainId:null,kind:'custom',color:'#b0443c',description:'原题前提或原答案与已引用的现行依据冲突；保留作历史对照，不作为现行依据。'},
  {id:'common-version-sensitive',name:'版本相关',domainId:null,kind:'custom',color:'#80609c',description:'具体实现、API、模型或产品行为需核对目标版本；基础概念与版本细节分开理解。'},
  {id:'common-ai-assisted',name:'含AI生成内容',domainId:null,kind:'custom',color:'#80609c',description:'部分释义或例句来自上游AI；审核发布不等同于逐项专家鉴定。'},
  {id:'common-incomplete-reference',name:'资料待补充',domainId:null,kind:'custom',color:'#92724a',description:'原资料明确缺少典故、拼音或用例等字段，保留缺失说明。'},
  {id:'common-syllabus-reference',name:'考纲归属待核验',domainId:null,kind:'custom',color:'#92724a',description:'级别或考试词表标签来自第三方历史数据，不代表词义过时或完整官方考纲。'},
  {id:'method-reference',name:'词条学习',domainId:null,kind:'method',color:'#856142',description:'学习词义、物质身份、性质及关联知识。'},
  {id:'method-concept',name:'概念题',domainId:null,kind:'method',color:'#856142',description:'解释定义、基本原理与适用边界'},
  {id:'method-application',name:'应用题',domainId:null,kind:'method',color:'#856142',description:'把知识用于具体场景与实践'},
  {id:'method-code-reading',name:'代码阅读',domainId:null,kind:'method',color:'#856142',description:'阅读并推演代码行为与边界'},
  {id:'method-comparison',name:'对比辨析',domainId:null,kind:'method',color:'#856142',description:'比较方案、条件、收益与代价'},
  {id:'method-diagnosis',name:'排错分析',domainId:null,kind:'method',color:'#856142',description:'定位原因、验证假设与修复问题'},
];
const law='https://jtgl.beijing.gov.cn/jgj/jgxx/flfg/fl/205308/index.html';
const licence='https://jtgl.beijing.gov.cn/jgj/jgxx/flfg/gabgz/543498902/index.html';
const englishParts:Array<[string,string,RegExp]>=[
  ['noun','英语名词',/\bnoun\b|名词/i],['verb','英语动词',/\bverb\b|动词/i],
  ['adjective','英语形容词',/\badjective\b|形容词/i],['adverb','英语副词',/\badverb\b|副词/i],
  ['pronoun','英语代词',/\bpronoun\b|代词/i],['preposition','英语介词',/\bpreposition\b|介词/i],
  ['article','英语冠词与限定词',/\b(?:article|determiner)\b|冠词|限定词/i],
  ['conjunction','英语连词',/\bconjunction\b|连词/i],['interjection','英语感叹词',/\binterjection\b|感叹词/i],
  ['numeral','英语数词',/\b(?:numeral|number)\b|数词/i],
];
export const DRIVING_OBSOLESCENCE: Record<string,{reason:string;url:string}> = {};
function evidence(ids:string[],reason:string,url:string){for(const id of ids)DRIVING_OBSOLESCENCE[id]={reason,url};}
evidence(['DRV-CAR-OFFICIAL-000044','DRV-HIST-MOTO-1-1-1-29'],'原题饮酒驾驶的200—500元及暂扣1—3个月属于旧处罚；现行第九十一条按首次饮酒驾驶等情形分别规定，不能套用该原题数值。',law);
evidence(['DRV-CAR-OFFICIAL-000045','DRV-HIST-MOTO-1-1-1-30'],'原题把醉酒驾驶写为行政拘留、暂扣及旧罚款；现行第九十一条规定吊销驾驶证、依法追究刑事责任等，原处置框架不适用。',law);
evidence(['DRV-CAR-OFFICIAL-001180','DRV-CAR-OFFICIAL-001239'],'原题饮酒驾驶营运车辆的500元及暂扣三个月是旧规则；现行第九十一条针对营运车辆有独立的拘留、罚款、吊证及禁领规定。',law);
evidence(['DRV-CAR-OFFICIAL-001181','DRV-CAR-OFFICIAL-001240'],'原题醉酒驾驶营运车辆的旧行政处罚框架不适用；现行第九十一条涉及刑事责任、吊证和更长禁领期限。',law);
evidence(['DRV-CAR-OFFICIAL-001182','DRV-CAR-OFFICIAL-001241'],'原题以一年内被处罚两次以上作为相关吊证框架，不能替代现行第九十一条对醉酒、营运及重大事故分别规定的处理条件。',law);
evidence(['DRV-CAR-OFFICIAL-000311','DRV-CAR-OFFICIAL-000312','DRV-CAR-OFFICIAL-001255'],'原题按60周岁及旧提交期限、旧牵引车/大型货车条件组织身体证明与注销规则；现行第七十四条、第七十九条等已调整年龄和适用对象，不能直接沿用。',licence);
evidence(['DRV-CAR-OFFICIAL-001254'],'原题60周岁一律换领小型汽车驾驶证已不适用；现行第六十五条采用63周岁及经能力测试申请延期等条件。',licence);
evidence(['DRV-CAR-OFFICIAL-000052'],'题干关于伪造或使用伪造机动车登记证书的旧200—2000元罚款已不适用；现行第九十六条对该类证件规定拘留及2000—5000元罚款等处理。题目虽在问扣留车辆，旧处罚前提仍需标明。',law);
evidence(['DRV-CAR-OFFICIAL-000053'],'题干使用其他车辆牌证的旧200—2000元罚款已不适用；现行第九十六条对此规定2000—5000元罚款。扣留车辆这一知识点与失效罚款数额分别看待。',law);
evidence(['DRV-CAR-OFFICIAL-001207','DRV-CAR-OFFICIAL-001287'],'原判断题将60岁以上持大型客车或大型货车驾驶证一律换领小型汽车驾驶证判为正确；现行第六十五条已改为63岁及能力测试申请延期等条件。',licence);
evidence(['DRV-CAR-OFFICIAL-001193','DRV-CAR-OFFICIAL-001208','DRV-CAR-OFFICIAL-001288'],'原题按持有大型客货车等驾驶证、每周期未交体检结果一年即注销的旧框架设问；现行第七十二条、第七十四条及第七十九条分别规定审验、身体证明和注销的不同条件，不能沿用旧题的一概规则。',licence);
evidence(['DRV-CAR-OFFICIAL-001192'],'原题将取得牵引车资格两年以上、最近一个周期无满分作为增驾大型客车条件；现行第十七条采用重型牵引挂车资格一年以上及最近连续三个周期无满分等条件。',licence);

export interface TagDecision { ids:string[]; reasons:string[]; evidence?:{reason:string;url:string} }
const englishVocabularySections=new Set(['使用方式/搭配','例句','关联词汇']);
function hasEmptyEnglishVocabularySection(markdown:string):boolean {
  // Inspect whole section values, rather than any occurrence of “无”: it can
  // also be a real example sentence or a term card's valid lack of aliases.
  const headings=[...markdown.matchAll(/^ {0,3}(#{1,3})[ \t]+([^\r\n]+)\r?$/gm)];
  for(let i=0;i<headings.length;i++){
    const heading=headings[i]!;
    if(heading[1]!=='###')continue;
    const title=heading[2]!.replace(/[ \t]+#+[ \t]*$/,'').replace(/[ \t]/g,'').replace(/／/g,'/');
    if(!englishVocabularySections.has(title))continue;
    const body=markdown.slice(heading.index!+heading[0].length,headings[i+1]?.index??markdown.length).trim();
    if(body==='无')return true;
  }
  return false;
}
export function decideKnowledgeTags(question:Question,categories:Map<string,Category>,tags:Map<string,Tag>):TagDecision {
  const ids=new Set(question.tagIds),reasons:string[]=[];
  const domains=new Set(question.categoryIds.map(cid=>categories.get(cid)?.domainId));
  const prompt=question.title+'\n'+question.stemMarkdown;
  const reference=/^(EN-V-|JA-V-|ZH-I-|CHEM-|MED-DRUG-|TERM-)/.test(question.id);
  ids.add(reference?'method-reference':'method-concept');
  if(!reference&&/代码|输出|程序片段|```|:=|\b(?:const|let|var|SELECT)\b/.test(prompt))ids.add('method-code-reading');
  if(/场景|如何|怎样|故障|排查|部署|生产环境|候选表达|Choose|选择.*(?:用法|句子)|填入|典型反应|常见反应/.test(prompt))ids.add('method-application');
  if(/对比|区别|差异|辨析|相比|versus/.test(prompt))ids.add('method-comparison');
  if(/排错|排查|定位.*(?:问题|故障)|故障诊断/.test(prompt))ids.add('method-diagnosis');
  if(/^JA-V-/.test(question.id)){ids.add('common-ai-assisted');ids.add('common-syllabus-reference');}
  if(/^EN-V-/.test(question.id)&&question.tagIds.some(id=>/gk|cet|high.?school|exam/.test(id)))ids.add('common-syllabus-reference');
  if(/^EN-V-/.test(question.id)){
    const labels=[...question.answerMarkdown.matchAll(/^\*\*([^*\n]+)\*\*([^\n]*)/gm)].map(match=>match[1]+(/词性/.test(match[1])?match[2]:'')).join(' ');
    for(const [key,,pattern]of englishParts)if(pattern.test(labels))ids.add('en-pos-'+key);
  }
  if(reference&&/【缺失】|待补全|待补充|无可提取|未提供此词可核验/.test(question.explanationMarkdown))ids.add('common-incomplete-reference');
  if(/^EN-V-/.test(question.id)&&hasEmptyEnglishVocabularySection(question.explanationMarkdown))ids.add('common-incomplete-reference');
  const historical=/^DRV-CAR-OFFICIAL-|^DRV-HIST-MOTO-/.test(question.id);
  if(historical){ids.add(OUTDATED_TAG);reasons.push('官方公开历史题，上传日并非有效版本；原答案未整体改写为现行题。');}
  else if(domains.has('driving')&&question.categoryIds.some(id=>['drv-law','drv-regulations','drv-license','drv-points'].includes(id))){ids.add(OUTDATED_TAG);reasons.push('现行法规学习条目，修法后数值与资格条件可能变化；本标记不表示已发现失效。');}
  const evidence=DRIVING_OBSOLESCENCE[question.id];
  if(evidence){ids.add(OBSOLETE_TAG);ids.add(OUTDATED_TAG);reasons.push(evidence.reason);}
  if(domains.has('computer-science')){
    const categoryNames=question.categoryIds.map(id=>categories.get(id)?.name||'').join(' ');
    if(/\b(?:Kubernetes|K8s|Docker|React|Spring|NestJS|Nest|vLLM|Ollama|LangChain|MCP|Android)\b|模型部署|智能体|前端框架|容器|框架|运行时|数据库产品/i.test(categoryNames+' '+prompt)){
      ids.add('common-version-sensitive');ids.add(OUTDATED_TAG);reasons.push('框架、平台或工具行为依赖具体版本；此标记提示复核版本细节，不宣告原理失效。');
    }
  }
  // A subject area is not evidence of obsolete knowledge. Medical mechanisms
  // and basic terminology do not acquire a validity warning from their domain.
  // Explicit review tags (including user-selected validity warnings) remain;
  // the one-time content correction removes only the old catalog default.
  // Every referenced domain must have a scoped topic; reuse existing themes.
  for(const domain of domains){
    if(!domain||[...ids].some(id=>tags.get(id)?.domainId===domain))continue;
    const category=question.categoryIds.map(id=>categories.get(id)).find(c=>c?.domainId===domain);
    if(category)ids.add('topic-category-'+category.id);
  }
  return {ids:[...ids].sort((a,b)=>{const rank=(id:string)=>id===OBSOLETE_TAG?0:id===OUTDATED_TAG?1:2;return rank(a)-rank(b)||question.tagIds.indexOf(a)-question.tagIds.indexOf(b)||a.localeCompare(b);}),reasons,evidence};
}

export function enrichKnowledgePack<T extends {categories:Category[];tags:Tag[];questions:Question[]}>(pack:T):T {
  const categories=new Map(pack.categories.map(c=>[c.id,c])),tags=new Map(pack.tags.map(t=>[t.id,t]));
  const definitions=new Map(GLOBAL_KNOWLEDGE_TAGS.map(t=>[t.id,t]));
  for(const [key,name]of englishParts)definitions.set('en-pos-'+key,{id:'en-pos-'+key,name,domainId:'english',kind:'topic',color:'#5264db',description:'依据所选词义的明确词性字段标记；多义词可同时属于多个词性。'});
  for(const category of pack.categories)definitions.set('topic-category-'+category.id,{id:'topic-category-'+category.id,name:category.name,domainId:category.domainId,kind:'topic',color:'#5264db',description:'分类主题：'+category.name+'。'});
  const questions=pack.questions.map(q=>{
    const decision=decideKnowledgeTags(q,categories,tags);
    for(const tid of decision.ids)if(!tags.has(tid)){const definition=definitions.get(tid);if(!definition)throw new Error('Unknown inferred tag '+tid);tags.set(tid,definition);}
    let explanationMarkdown=q.explanationMarkdown;
    if(decision.evidence&&!explanationMarkdown.includes('<!-- current-validity-check -->'))explanationMarkdown+='\n\n<!-- current-validity-check -->\n### 当前适用性核验（2026-10-22）\n'+decision.evidence.reason+'\n\n此题保留历史原答案用于对照；通过审核不表示原答案恢复现行效力。[现行官方依据]('+decision.evidence.url+')。';
    return {...q,tagIds:decision.ids,explanationMarkdown};
  });
  return {...pack,tags:[...tags.values()],questions};
}
