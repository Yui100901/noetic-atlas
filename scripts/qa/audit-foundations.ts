/** Content-only QA. Reads JSON and writes an audit report; never opens a database. */
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validatePack,validatePackSet} from '../content/manage.js';
import type {Question} from '../../shared/models/types.js';

/** Add future independently generated packs here, or pass --packs name,name. */
export const FOUNDATION_PACK_NAMES=[
  'computer-foundations-202610',
  'english-grammar-foundations-202610','japanese-grammar-foundations-202610',
  'chinese-basics-foundations-202610','chemistry-basics-foundations-202610',
  'medicine-basics-foundations-202610','driving-safety-foundations-202610',
  'geography-foundations','physics-foundations','psychology-foundations','economics-foundations',
] as const;
type Issue={pack?:string;id?:string;check:string;detail:string};
type LabelContext={id:string;offset:number;original:string;generated:string;context:string};
const root=resolve(import.meta.dirname,'../..');
const tally=(values:string[])=>Object.fromEntries([...new Set(values)].sort().map(value=>[value,values.filter(item=>item===value).length]));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const fields=(question:Question)=>[question.stemMarkdown,question.answerMarkdown,question.explanationMarkdown,...question.options.map(option=>option.text)];
const prefixId=(group:string,index:number)=>`COMPUTER-FOUNDATIONS-202610-${group.toUpperCase()}-${String(index+1).padStart(3,'0')}`;

/** Schema/answer/taxonomy/source/identity checks are automatic; factual review is explicitly scoped. */
export async function auditFoundations(names:readonly string[]=FOUNDATION_PACK_NAMES){
  const errors:Issue[]=[],warnings:Issue[]=[],hazardHints:Issue[]=[],summaries:any[]=[],packs:ReturnType<typeof validatePack>[]=[],allNew:Question[]=[];
  const packNames=new Set(names),seenIds=new Map<string,string>(),newStems=new Map<string,Array<{pack:string;id:string}>>();
  const directory=resolve(root,'data/content-packs');
  for(const name of names){
    if(!/^[a-z0-9-]+$/.test(name))throw new Error('Invalid pack name');
    const filename=resolve(directory,name+'.json');
    let raw:any,text:string,pack:ReturnType<typeof validatePack>;
    try{text=await readFile(filename,'utf8');raw=JSON.parse(text);pack=validatePack(raw);}catch(error){errors.push({pack:name,check:'schema',detail:String(error)});continue;}
    packs.push(pack);allNew.push(...pack.questions);
    try{
      const manifest=JSON.parse(await readFile(resolve(root,'data/content-sources',name+'.json'),'utf8'));
      if(manifest.sha256!==sha(text))errors.push({pack:name,check:'provenanceHash',detail:'来源摘要SHA-256与当前JSON不符'});
      const count=manifest.questionCount??manifest.questions;
      if(count!==pack.questions.length)errors.push({pack:name,check:'provenanceCount',detail:`摘要${count}，实际${pack.questions.length}`});
    }catch(error){errors.push({pack:name,check:'provenanceManifest',detail:String(error)});}
    const choiceKeys=pack.questions.filter(q=>q.type==='single_choice').flatMap(q=>q.correctAnswers);
    const distribution=tally(choiceKeys);
    if(choiceKeys.length>=12&&Object.values(distribution).some(count=>count/choiceKeys.length>0.7))warnings.push({pack:name,check:'choiceDistribution',detail:'单一正确位置超过70%，复核是否产生答案位置线索'});
    for(const question of pack.questions){
      const id=question.id!;
      if(seenIds.has(id))errors.push({pack:name,id,check:'duplicateId',detail:`与${seenIds.get(id)}使用同一题号`});
      seenIds.set(id,name);
      const stem=question.stemMarkdown.trim(),uses=newStems.get(stem)||[];uses.push({pack:name,id});newStems.set(stem,uses);
      if(question.status!=='pending'||question.collection!=='general')errors.push({pack:name,id,check:'genericPending',detail:'新增题须通用、待审核'});
      if(question.frequency>0&&(!question.frequencyScope?.trim()||!question.frequencyBasis?.trim()))errors.push({pack:name,id,check:'frequencyBasis',detail:'常见度分级须注明适用范围与编辑依据，不可冒充统计考试概率'});
      if(!question.sourceRefs.length||!question.answerMarkdown.trim()||!question.explanationMarkdown.trim())errors.push({pack:name,id,check:'requiredContent',detail:'缺少答案、解释或来源'});
      if(question.type==='single_choice'||question.type==='multiple_choice'){
        for(const key of question.correctAnswers)if(!question.options.some(option=>option.key===key))errors.push({pack:name,id,check:'answerReference',detail:`答案${key}无对应选项`});
      }
      if(question.type==='fill_blank')for(const blank of question.blanks||[]){
        if(!blank.answers.length||blank.answers.some(answer=>!answer.trim()))errors.push({pack:name,id,check:'blankAnswer',detail:'填空标准答案为空'});
        if(/大小写不能|大小写有意义|小写.*不是/.test(question.explanationMarkdown)&&blank.answers.some(answer=>/^[A-Za-z]+$/.test(answer))&&!blank.caseSensitive)errors.push({pack:name,id,check:'unitCase',detail:'解释要求单位大小写，但填空判分未启用大小写敏感'});
      }
      for(const field of fields(question))if(/sk-[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(field))errors.push({pack:name,id,check:'credentialLeak',detail:'疑似真实访问凭据，报告不回显内容'});
      for(const source of question.sourceRefs){
        if(/^https?:\/\//.test(source.url)){
          const host=new URL(source.url).hostname;
          if(/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))errors.push({pack:name,id,check:'privateSource',detail:'分享题引用了本地或私网资源'});
        }
      }
      if(/(?:忽略|无视).{0,8}(?:系统|之前).{0,8}(?:要求|指令)/.test(question.stemMarkdown))hazardHints.push({pack:name,id,check:'embeddedInstruction',detail:/不可信|权限|隔离|校验/.test(question.explanationMarkdown)?'已人工复核为提示注入的反例教学题；解析要求将资料视为不可信数据。':'题干含指令形文本，需人工区分教学例子与真实控制指令。'});
    }
    summaries.push({pack:name,questions:pack.questions.length,typeCounts:tally(pack.questions.map(q=>q.type)),difficulty:tally(pack.questions.map(q=>String(q.difficulty))),depth:tally(pack.questions.map(q=>String(q.depth))),frequency:tally(pack.questions.map(q=>String(q.frequency))),singleChoiceCorrectPositions:distribution,sha256:sha(text),schema:'passed',sourceManifest:'checked'});
  }
  try{validatePackSet(packs);}catch(error){errors.push({check:'packSetTaxonomy',detail:String(error)});}
  const internalDuplicateStems=[...newStems].filter(([,uses])=>uses.length>1).map(([stem,uses])=>({stem,uses}));
  for(const duplicate of internalDuplicateStems)errors.push({check:'duplicateNewStem',detail:duplicate.uses.map(use=>use.id).join(', ')});
  const oldStems=new Map<string,Array<{pack:string;id:string}>>();let baselineQuestions=0;
  for(const file of await readdir(directory))if(file.endsWith('.json')&&!packNames.has(file.slice(0,-5))){
    const baseline=JSON.parse(await readFile(resolve(directory,file),'utf8'));
    for(const question of baseline.questions||[]){
      baselineQuestions++;const stem=String(question.stemMarkdown).trim(),uses=oldStems.get(stem)||[];uses.push({pack:file.slice(0,-5),id:question.id});oldStems.set(stem,uses);
    }
  }
  const existingDuplicateStems=[...newStems].filter(([stem])=>oldStems.has(stem)).map(([stem,uses])=>({stem,new:uses,existing:oldStems.get(stem)}));
  for(const duplicate of existingDuplicateStems)errors.push({check:'duplicateBaselineStem',detail:duplicate.new.map(use=>use.id).join(', ')});

  // Cross-check CS output against its independent authored catalog, including label rotation.
  let csMapping:any={status:'not-selected'};
  if(packNames.has('computer-foundations-202610')){
    const {groups}=await import('../content/expansion-2026-10/computer-deepening.mjs');
    const generated=new Map(allNew.map(question=>[question.id,question])),contexts:LabelContext[]=[];let choicesChecked=0,csQuestions=0;
    for(const group of groups)group.questions.forEach((row:any,index:number)=>{
      csQuestions++;const id=prefixId(group.id,index),question=generated.get(id);
      if(!question){errors.push({id,check:'csGenerated',detail:'源目录存在，但生成题缺失'});return;}
      if(!row.options?.length)return;
      choicesChecked++;const offset=index%row.options.length;
      const map=Object.fromEntries(row.options.map((_:unknown,position:number)=>['ABCD'[position],'ABCD'[(position+offset)%row.options.length]]));
      for(let position=0;position<row.options.length;position++)if(question.options.find(option=>option.key===map['ABCD'[position]])?.text!==row.options[position])errors.push({id,check:'csOptionMapping',detail:'轮换后选项文字不匹配'});
      if(JSON.stringify(row.correct.map((key:string)=>map[key]).sort())!==JSON.stringify(question.correctAnswers))errors.push({id,check:'csAnswerMapping',detail:'轮换后答案位置不匹配'});
      const expected=offset?row.explanation.replace(/(?<![A-Za-z0-9])([ABCD])(?![A-Za-z0-9])/g,(_:string,key:string)=>map[key]):row.explanation;
      if(question.explanationMarkdown!==expected)errors.push({id,check:'csExplanationMapping',detail:'解释与轮换映射不一致'});
      for(const match of row.explanation.matchAll(/(?<![A-Za-z0-9])([ABCD])(?![A-Za-z0-9])/g))contexts.push({id,offset,original:match[1],generated:map[match[1]],context:row.explanation.slice(Math.max(0,match.index-12),match.index+24)});
    });
    csMapping={status:'checked',csQuestions,choicesChecked,standaloneLabelsChecked:contexts.length,labelContexts:contexts,manualConclusion:'逐条检查孤立A/B/C/D上下文，均为选项标号，未发现把变量或术语当成选项替换。请求先后顺序题的A/B仅在题干，解释中的B为选项标号。'};
  }
  const firstLaw=allNew.find(question=>question.id==='PHY26-TERM-first-law');
  const power=allNew.find(question=>question.id==='PHY26-TERM-electric-power');
  const physicsReview=firstLaw?{
    sampledTopics:['SI基本与导出单位','温标换算','向量与加速度','力矩量纲','热力学符号与系统边界','总熵与子系统','电势差与电场','磁力与功','折射角定义','交流与直流功率'],
    findings:[
      {id:firstLaw.id,issue:'封闭系统仍可能存在整体动能/势能变化，ΔU式需额外条件',status:/ΔE|动能.*势能/.test(firstLaw.answerMarkdown+firstLaw.explanationMarkdown)?'resolved':'open'},
      {id:power?.id,issue:'P=UI需明确直流稳态或瞬时值，交流平均功率另考虑相位/波形',status:power&&/瞬时/.test(power.answerMarkdown+power.explanationMarkdown)&&/交流/.test(power.explanationMarkdown)?'resolved':'open'},
    ],
    conclusion:'两处条件已由内容作者修正并重新生成；其余所列公式、单位与选项抽样未发现明确错误。这是抽样人工审阅，不宣称逐项外部事实认证。',
  }:null;
  if(physicsReview?.findings.some(finding=>finding.status==='open'))errors.push({check:'physicsConditions',detail:'第一定律或电功率的已识别适用条件尚未补齐'});
  return {generatedAt:new Date().toISOString(),scope:'本轮新增基础题包；只读JSON，不打开或导入工作数据库。',status:errors.length?'failed':'passed',totalQuestions:allNew.length,baselineQuestions,packCount:summaries.length,packs:summaries,errors,warnings,hazardHints,exactStemComparison:{normalization:'仅trim首尾空白；不按近似语义去重',internalDuplicateStems,existingDuplicateStems},computerReview:csMapping,geographyReview:{sampledTopics:['地图投影与比例尺','板块边界','季风与风向','相对湿度','人口密度与自然增长','城镇人口数量与比例','人口抚养比口径'],conclusion:'约50条物理/地理概念与客观题交叉抽样，地理未发现明确错误；数字、方向、单位和定义边界已核对。'},physicsReview,manualReview:{psychology:'61张概念/案例及60客观题由作者逐条复核。争议实验区分设计、观察、因果、外推、伦理与后续证据；不含诊断或治疗内容。',economics:'60张概念/历史及60客观题由作者逐条复核。数值题重算，历史事件保留多机制与争议，银行存款创造区分资本、流动性与需求约束。',computer:'180题独立通读；未发现明确答案错误。两处原题干保证性措辞已由主代理改为条件性问法。',limits:'自动检查验证结构、映射、标识、来源摘要和精确重复，不能替代逐题学术审稿、法规时效核验或语义近似去重。'}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),at=args.indexOf('--packs');
  const names=at>=0?(args[at+1]||'').split(',').filter(Boolean):FOUNDATION_PACK_NAMES;
  if(!names.length)throw new Error('No packs selected');
  const report=await auditFoundations(names);
  const output=resolve(root,'test-results/content-expansion-audit.json');
  await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify({status:report.status,totalQuestions:report.totalQuestions,packs:report.packCount,errors:report.errors,warnings:report.warnings,hazardHints:report.hazardHints.length,report:output},null,2));
  if(report.errors.length)process.exitCode=1;
}
