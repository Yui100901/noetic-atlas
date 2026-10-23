import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { chapters as first } from './computer-objective-apps-data-1.mjs';
import { chapters as second } from './computer-objective-apps-data-2.mjs';
import { chapters as third } from './computer-objective-apps-data-3.mjs';

const root=resolve(import.meta.dirname,'../../..'),chapters=[...first,...second,...third];
const seed=JSON.parse(await readFile(join(root,'data/seed.json'),'utf8'));
const old=JSON.parse(await readFile(join(root,'data/content-packs/computer-expansion.json'),'utf8'));
const normalize=text=>text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu,'');
const existing=new Set([...seed.questions,...old.questions].flatMap(q=>[normalize(q.title),normalize(q.stemMarkdown)]));
const questions=[],counts={},usedCategories=new Set();
// Hand-reviewed [difficulty, depth] exceptions by chapter and 1-based row.
// Factual recall, application and failure-boundary reasoning are graded on
// their content; a multiple-choice format itself does not imply a higher grade.
const ratings={
 'SQL与SQLite应用':{1:[1,1],6:[1,1],7:[1,1],13:[1,1],29:[1,1],31:[1,1],35:[1,1],37:[1,1],38:[2,1],39:[1,1],40:[2,2]},
 'PostgreSQL与MySQL实践':{7:[1,1],29:[1,1],35:[2,1],36:[1,1],37:[2,2],38:[2,1],39:[1,1],40:[2,2]},
 'Redis与缓存工程':{13:[1,1],25:[1,1],31:[2,2],35:[1,1],36:[2,1],37:[1,1],38:[2,1],39:[1,1],40:[2,2]},
 '消息与分布式业务':{15:[4,4],20:[2,2],34:[2,2],35:[1,1],36:[1,1],37:[2,2],38:[1,1],40:[2,2]},
 '后端框架与服务边界':{5:[1,1],35:[2,1],36:[1,1],37:[1,1],38:[1,1],40:[1,1]},
 '前端交互与可访问性':{8:[3,3],9:[1,1],16:[1,1],17:[1,1],19:[1,1],35:[1,1],36:[1,1],37:[1,1],38:[2,2],40:[1,1]},
 '测试与交付流程':{4:[1,1],17:[1,1],35:[1,1],36:[3,3],37:[2,2],38:[1,1],39:[1,1],40:[2,2]},
 'AI辅助开发与评测':{2:[1,1],3:[1,1],4:[2,2],10:[1,1],20:[2,2],35:[1,1],36:[2,2],37:[1,1],38:[1,1],39:[1,1],40:[2,2]},
 'RAG智能体与模型服务':{6:[2,2],9:[4,4],18:[2,2],21:[4,4],26:[2,2],31:[3,2],34:[2,1],35:[1,1],36:[2,2],37:[2,2],38:[2,2],39:[2,2],40:[1,1]},
 '容器平台与可观察性':{2:[1,1],18:[2,2],20:[2,2],35:[2,1],36:[2,2],37:[1,1],38:[2,2],39:[2,2],40:[2,1]},
};
for(const chapter of chapters){
  const rows=chapter.rows.trim().split('\n').filter(line=>line.trim()&&!line.startsWith('#'));
  const local={single_choice:0,multiple_choice:0,true_false:0,fill_blank:0};
  for(const [rowIndex,row] of rows.entries()){
    const [kind,stem,choices,answer,explanation,followup]=row.split('§');
    if(!/^[SMTF][1-4]$/.test(kind)||!followup||!explanation)throw new Error('Incomplete catalog row: '+row);
    const type={S:'single_choice',M:'multiple_choice',T:'true_false',F:'fill_blank'}[kind[0]],level=Number(kind[1]);
    const number=questions.length+1,id='CS-OBJ-APP-'+String(number).padStart(6,'0');
    const q={id,title:`${chapter.title} · ${stem.replace(/\n/g,' ').slice(0,110)}`,type,stemMarkdown:stem,answerMarkdown:'',explanationMarkdown:`### 判断依据与干扰项边界\n${explanation}\n\n### 延伸追问\n${followup}\n\n### 复习检查\n说明题设中的约束为何必要，并用一个最小反例验证误选项；涉及具体版本、隔离级别和配置时，以题设与官方文档为准。\n\n本题情境、选项及解析为原创学习练习，非厂商认证试题。`,options:[],correctAnswers:[],difficulty:level,depth:Math.min(4,level),frequency:level<=2?2:1,frequencyScope:'计算机技术面试与工程基础复习；编辑参考分级',frequencyBasis:'根据通用基础与工程场景的重要性作编辑参考，不是招聘统计、出现概率或公司题目承诺。',collection:'general',status:'pending',categoryIds:chapter.categories,tagIds:['com-objective-practice'],sourceRefs:chapter.sources.map(([label,url])=>({label,url})),sourceDocument:null,sourceAnchor:null};
    const rating=ratings[chapter.title]?.[rowIndex+1];if(rating){q.difficulty=rating[0];q.depth=rating[1];}
    q.explanationMarkdown+=' 原创题目内容按CC0 1.0提供；所链接官方文档仍适用各自许可。';
    if(type==='single_choice'||type==='multiple_choice'){
      const values=choices.split('¦');if(values.length<3||new Set(values).size!==values.length)throw new Error('Invalid options: '+id);
      const keys=answer.split('');if(type==='single_choice'&&keys.length!==1||type==='multiple_choice'&&keys.length<2)throw new Error('Invalid answer: '+id);
      const shuffled=values.map((_,i)=>i);
      for(let i=shuffled.length-1;i>0;i--){const random=createHash('sha256').update(stem+'\0'+i).digest().readUInt32BE(0),j=random%(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
      q.options=shuffled.map((source,i)=>({key:String.fromCharCode(65+i),text:values[source]}));
      q.correctAnswers=keys.map(key=>String.fromCharCode(65+shuffled.indexOf(key.charCodeAt(0)-65))).sort();
      q.answerMarkdown=q.correctAnswers.map(key=>`${key}：${q.options.find(option=>option.key===key).text}`).join('\n\n');
    }else if(type==='true_false'){
      if(!['true','false'].includes(answer))throw new Error('Invalid boolean: '+id);q.correctAnswers=[answer];q.answerMarkdown=answer==='true'?'正确':'错误';
    }else{
      const answers=answer.split('¦');q.blanks=[{id:'b1',label:'第1空',answers,caseSensitive:false,trim:true}];q.answerMarkdown=answers.join(' / ');
    }
    if(existing.has(normalize(stem))||existing.has(normalize(q.title)))throw new Error('Existing normalized duplicate: '+id);
    existing.add(normalize(stem));existing.add(normalize(q.title));questions.push(q);local[type]++;for(const category of chapter.categories)usedCategories.add(category);
  }
  const expected={single_choice:16,multiple_choice:12,true_false:6,fill_blank:6};
  if(JSON.stringify(local)!==JSON.stringify(expected))throw new Error(chapter.title+' quota '+JSON.stringify(local));counts[chapter.title]=local;
}
if(questions.length!==400)throw new Error('Expected 400 objective questions');
const categoryMap=new Map(seed.categories.map(c=>[c.id,c]));
for(const id of [...usedCategories]){let category=categoryMap.get(id);if(!category)throw new Error('Unknown category '+id);while(category.parentId){usedCategories.add(category.parentId);category=categoryMap.get(category.parentId);}}
const pack={schemaVersion:1,generatedAt:'2026-10-22T00:00:00.000Z',domains:seed.domains.filter(d=>d.id==='computer-science'),categories:seed.categories.filter(c=>usedCategories.has(c.id)),tags:[{id:'com-objective-practice',name:'客观专项',kind:'custom',domainId:null,color:'#5264db',description:'用于系统化巩固计算机知识的客观练习。'}],questions,questionBanks:[{id:'com-objective-apps-bank',name:'计算机 · 应用与工程客观专项400题',description:'160单选、120多选、60判断、60填空；原创边界与工程情境，新增均待审核。',questionIds:questions.map(q=>q.id)}],documents:[],papers:[]};
await mkdir(join(root,'data/content-packs'),{recursive:true});await mkdir(join(root,'data/content-sources'),{recursive:true});
const output=JSON.stringify(pack,null,2)+'\n';await writeFile(join(root,'data/content-packs/computer-objective-apps.json'),output);
const histogram=(values)=>Object.fromEntries([...new Set(values)].sort().map(key=>[key,values.filter(value=>value===key).length]));
const distributions={singleAnswer:histogram(questions.filter(q=>q.type==='single_choice').map(q=>q.correctAnswers.join(''))),multipleAnswers:histogram(questions.filter(q=>q.type==='multiple_choice').map(q=>q.correctAnswers.join(''))),multipleAnswerSizes:histogram(questions.filter(q=>q.type==='multiple_choice').map(q=>q.correctAnswers.length)),difficulty:histogram(questions.map(q=>q.difficulty)),depth:histogram(questions.map(q=>q.depth))};
await writeFile(join(root,'data/content-sources/computer-objective-apps.json'),JSON.stringify({id:'computer-objective-apps',generatedAt:pack.generatedAt,questionCount:400,status:'pending',license:'CC0-1.0',licenseUrl:'https://creativecommons.org/publicdomain/zero/1.0/',authorship:'题干、选项、干扰项解释及追问由认知星图独立编写。官方文档仅用于核对技术规则，未复制厂商认证试题或商业题库。',counts,distributions,grading:'逐题显式初评，另有基于内容的人工复核映射；术语记忆深度与应用推理可不同，不按题型绑定难度。D1基础辨识，D2常见应用，D3机制与失败边界，D4跨系统恢复/一致性。',verification:'实际执行了生成器配额/重复检查和manage结构/迁移校验；并非在所有框架、Redis、Kafka、K8s和GPU环境实跑全部场景。解析中的延伸追问是复习/验证建议，不是已执行的实验报告。',duplicateCheck:'对原始1543题及computer-expansion新增题的标题/题干执行NFKC、去标点和空白、小写归一后去重；包内同时去重。',frequency:'编辑参考分级，非统计概率。',sources:chapters.map(c=>({topic:c.title,categoryIds:c.categories,refs:c.sources.map(([label,url])=>({label,url}))})),sha256:createHash('sha256').update(output).digest('hex')},null,2)+'\n');
console.log(JSON.stringify({questions:questions.length,counts,bytes:Buffer.byteLength(output)},null,2));
