import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sections, levels } from './computer-objective-systems-catalog.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const stamp='2026-10-22T00:00:00.000Z';
const seed=JSON.parse(await fs.readFile(path.join(root,'data/seed.json'),'utf8'));
const old=JSON.parse(await fs.readFile(path.join(root,'data/content-packs/computer-expansion.json'),'utf8'));
const normalize=text=>text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
const seen=new Set([...seed.questions,...old.questions].map(q=>normalize(q.title)));
const questions=[],topics=[],sources=new Set();
const rules={s:{count:16,fields:6,type:'single_choice'},m:{count:12,fields:7,type:'multiple_choice'},t:{count:6,fields:4,type:'true_false'},f:{count:6,fields:4,type:'fill_blank'}};
const shuffle=(items,salt)=>{
  const result=[...items],bytes=crypto.createHash('sha256').update(salt).digest();
  for(let i=result.length-1;i>0;i--){const j=bytes[i]% (i+1);[result[i],result[j]]=[result[j],result[i]];}
  return result;
};
for(const section of sections){
  const start=questions.length;
  let groupIndex=0;
  for(const [kind,rule]of Object.entries(rules)){
    const rows=section[kind].trim().split(/\r?\n/).filter(Boolean).map(line=>line.split('|').map(x=>x.trim()));
    if(rows.length!==rule.count||rows.some(row=>row.length!==rule.fields||row.some(x=>!x)))throw new Error(`Malformed ${section.name}/${kind}`);
    const d=levels[section.category]?.d[groupIndex],z=levels[section.category]?.z[groupIndex++];
    if(!d||!z||d.length!==rows.length||z.length!==rows.length||!/^[1-4]+$/.test(d+z))throw new Error('Missing explicit per-question levels: '+section.name+'/'+kind);
    for(const [rowIndex,row]of rows.entries()){
      const [stem]=row,key=normalize(stem);
      if(seen.has(key))throw new Error('Question title already exists: '+stem);
      seen.add(key);
      const q={id:`CS-OBJ-SYS-${String(questions.length+1).padStart(6,'0')}`,title:stem,type:rule.type,stemMarkdown:stem,answerMarkdown:'',explanationMarkdown:'',options:[],correctAnswers:[],difficulty:Number(d[rowIndex]),depth:Number(z[rowIndex]),frequency:section.category==='reverse'?1:2,frequencyScope:section.name+'客观知识巩固',frequencyBasis:'编辑基于学习与岗位相关性的复习优先建议，非面试命中率或考试统计；1为拓展、2为常规掌握。',collection:'general',status:'pending',categoryIds:[section.category],tagIds:[...section.tags,'com-objective-practice'],sourceRefs:section.sources.map(url=>({label:'官方规范或项目维护者文档：'+new URL(url).hostname,url})),sourceDocument:null,sourceAnchor:null,createdAt:stamp,updatedAt:stamp};
      let reason,follow;
      if(kind==='s'||kind==='m'){
        let choices;
        if(kind==='s'){
          const [,answer,wrong1,wrong2,why,probe]=row;
          choices=[{text:answer,correct:true},{text:wrong1,correct:false},{text:wrong2,correct:false}];reason=why;follow=probe;
        }else{
          const [,answer1,answer2,wrong1,wrong2,why,probe]=row;
          choices=[{text:answer1,correct:true},{text:answer2,correct:true},{text:wrong1,correct:false},{text:wrong2,correct:false}];reason=why;follow=probe;
        }
        if(new Set(choices.map(c=>c.text)).size!==choices.length)throw new Error('Duplicate choices: '+stem);
        const ordered=shuffle(choices,q.id);
        q.options=ordered.map((c,i)=>({key:String.fromCharCode(65+i),text:c.text}));
        q.correctAnswers=ordered.flatMap((c,i)=>c.correct?[String.fromCharCode(65+i)]:[]);
        q.stemMarkdown+=kind==='m'?'\n\n请选择所有成立的选项（多选）。':'\n\n请选择最合适的一项。';
        q.answerMarkdown=`**正确选项：${q.correctAnswers.join('、')}**\n\n`+ordered.flatMap((c,i)=>c.correct?[`${String.fromCharCode(65+i)}. ${c.text}`]:[]).join('\n\n');
        q.explanationMarkdown=`### 核心依据\n${reason}\n\n### 干扰项与边界\n`+ordered.flatMap((c,i)=>!c.correct?[`- ${String.fromCharCode(65+i)}「${c.text}」不能作为本题结论。应回到题干中的具体对象与上述机制，不能把该项承诺扩大为无条件保证。`]:[]).join('\n');
      }else if(kind==='t'){
        const [,truth,why,probe]=row;
        if(!['true','false'].includes(truth))throw new Error('Bad judgment answer: '+stem);
        reason=why;follow=probe;q.correctAnswers=[truth];q.answerMarkdown=truth==='true'?'正确。':'错误。';
        q.explanationMarkdown=`### 判断依据\n${reason}\n\n### 判断边界\n本题判断的是题干所述具体关系；改变对象、版本或执行前提后，不能只沿用原判断而省略重新推演。`;
      }else{
        const [,answer,why,probe]=row;
        reason=why;follow=probe;q.answerMarkdown=answer;q.blanks=[{id:'b1',label:'第1空',answers:[answer],caseSensitive:false,trim:true}];
        q.explanationMarkdown=`### 答案与用法\n${answer}：${reason}\n\n### 记忆边界\n请把术语与题干中的实际机制对应，不把记住名称当成对其适用范围的完整理解。`;
      }
      q.explanationMarkdown+=`\n\n### 追问与参考回答\n${follow}\n\n### 内容与验证说明\n本题为认知星图原创客观练习，未摘录商业题库；来源用于核对事实和延伸阅读。代码、运行库与平台行为按目标版本验证；安全及程序分析练习仅面向自有或明确授权环境。`;
      for(const url of section.sources)sources.add(url);
      questions.push(q);
    }
  }
  topics.push({name:section.name,categoryId:section.category,total:questions.length-start,typeCounts:{single_choice:16,multiple_choice:12,true_false:6,fill_blank:6},sources:section.sources});
}
const typeCounts=Object.fromEntries(Object.values(rules).map(({type})=>[type,questions.filter(q=>q.type===type).length]));
if(questions.length!==400||typeCounts.single_choice!==160||typeCounts.multiple_choice!==120||typeCounts.true_false!==60||typeCounts.fill_blank!==60)throw new Error('Objective pack distribution changed');
const categories=new Map(seed.categories.map(c=>[c.id,c])),needed=new Set(questions.flatMap(q=>q.categoryIds));
for(const id of [...needed]){let c=categories.get(id);if(!c)throw new Error('Unknown category '+id);while(c.parentId){needed.add(c.parentId);c=categories.get(c.parentId);if(!c)throw new Error('Missing ancestor');}}
const tagIds=new Set(questions.flatMap(q=>q.tagIds));tagIds.delete('com-objective-practice');
const tags=seed.tags.filter(t=>tagIds.has(t.id));if(tags.length!==tagIds.size)throw new Error('Unknown source tag');
tags.push({id:'com-objective-practice',name:'客观专项',domainId:null,kind:'custom',color:'#5264db',description:'用于系统化巩固计算机知识的客观练习。'});
const pack={schemaVersion:1,generatedAt:stamp,domains:seed.domains.filter(d=>d.id==='computer-science'),categories:seed.categories.filter(c=>needed.has(c.id)),tags,questions,questionBanks:[{id:'bank-cs-objective-systems-202610',name:'计算机客观专项·语言与系统400题',description:'Go、Java、Rust、TS/Node、Python、操作系统、网络、安全、逆向、Android；单选160、多选120、判断60、填空60。原创待审核。',questionIds:questions.map(q=>q.id)}],documents:[],papers:[]};
const bytes=JSON.stringify(pack,null,2)+'\n';
const manifest={id:'computer-objective-systems',title:'计算机语言与系统客观专项',generatedAt:stamp,license:'Project-authored',redistribution:'题干、选项与中文解析由认知星图独立编写；不复制商业题库或官方文档长段落。官方及维护者资料仅供事实核验与延伸阅读，其原文许可不被本项目据为己有。',statistics:{total:400,typeCounts,pending:400,published:0,subjective:0,topics:10},quality:{independentStems:400,focusedExplanations:400,focusedFollowups:400,duplicateCheck:'与base seed1543题及computer-expansion340题按NFKC、忽略空白标点符号、大小写进行标题去重；本包内同样去重。覆盖相关概念的不同应用视角不表示逐字重复，最终仍需用户审核。',scope:'每专题40项不同对象或机制，非同题正反翻转或替换数字；每题含具体依据、追问与适用边界。'},frequencyPolicy:'frequency为编辑复习优先建议，非统计频率或面试命中率；所有题目均待用户审核。',sources:[...sources].sort().map(url=>({url,kind:'official-or-maintainer-primary',purpose:'事实核验与延伸阅读，题干和解析原创'})),topics,rebuild:'node scripts/content/computer/computer-objective-systems.mjs',output:'data/content-packs/computer-objective-systems.json',sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
manifest.levelPolicy='D/Z均由catalog中逐题显式映射标注，不按题型自动决定。D1识别、D2机制应用、D3交错/多边界推演、D4高级约束；Z独立描述解释深度。例：gofmt不自动优化算法为D1，unsafe前提、重定位与复杂信任边界可为D4。';
const distribution=items=>items.reduce((counts,key)=>(counts[key]=(counts[key]||0)+1,counts),{});
manifest.answerDistribution={singleChoice:distribution(questions.filter(q=>q.type==='single_choice').map(q=>q.correctAnswers.join(''))),multipleChoice:distribution(questions.filter(q=>q.type==='multiple_choice').map(q=>[...q.correctAnswers].sort().join('')))};
manifest.levelDistribution=Object.fromEntries(Object.values(rules).map(({type})=>[type,{difficulty:distribution(questions.filter(q=>q.type===type).map(q=>q.difficulty)),depth:distribution(questions.filter(q=>q.type===type).map(q=>q.depth))}]));
await fs.mkdir(path.join(root,'data/content-packs'),{recursive:true});await fs.mkdir(path.join(root,'data/content-sources'),{recursive:true});
await fs.writeFile(path.join(root,'data/content-packs/computer-objective-systems.json'),bytes);
await fs.writeFile(path.join(root,'data/content-sources/computer-objective-systems.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({questions:questions.length,typeCounts,sha256:manifest.sha256},null,2));
