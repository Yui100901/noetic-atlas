/** Content tooling never promotes new questions or overwrites the user's rows. */
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store, type Table } from '../../server/core/store.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import { questionSchema, domainSchema, categorySchema, tagSchema, questionBankSchema, id as idSchema } from '../../server/core/validation.js';
import { assetRecordSchema } from '../../server/modules/assets/schema.js';
import type { Question } from '../../shared/models/types.js';
import { paperExportDocument } from '../../server/modules/transfer/exports.js';
import { enrichKnowledgePack } from '../../shared/questions/knowledge-tags.js';
import { vocabularyPromptIsSafe } from '../../shared/questions/vocabulary.js';

const root=resolve(import.meta.dirname,'../..');
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const stamp='2026-10-22T00:00:00Z';
const canonical=(r:any):string=>Array.isArray(r)?'['+r.map(canonical).join(',')+']':r&&typeof r==='object'?'{'+Object.entries(r).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}':JSON.stringify(r);
function semantic(record:any,table:string){
  const {createdAt,updatedAt,status,...value}=record;
  if(table==='papers'){delete value.archived;delete value.version;delete value.questionCount;}
  return sha(canonical(value));
}
function mapStrings(value:any,transform:(text:string)=>string):any {
  if(typeof value==='string')return transform(value);
  if(Array.isArray(value))return value.map(item=>mapStrings(item,transform));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapStrings(item,transform)]));
  return value;
}
function recordGroups(pack:any):Array<[Table,any[]]>{return [['domains',pack.domains],['categories',pack.categories],['tags',pack.tags],['questions',pack.questions],['assets',pack.assets],['question_banks',pack.questionBanks],['papers',wordlistPapers(pack)]];}
export function validatePackSet(packs:any[]) {
  const indexes=new Map<string,Map<string,string>>();
  for(const pack of packs)for(const[table,rows]of recordGroups(pack))for(const row of rows){
    const index=indexes.get(table)||new Map<string,string>(),signature=semantic(row,table);
    if(index.has(row.id)&&index.get(row.id)!==signature)throw new Error(`内容包之间存在不同内容的相同ID：${table}/${row.id}`);
    index.set(row.id,signature);indexes.set(table,index);
  }
}
export function assertImportCompatible(store:Store,packs:any[]) {
  validatePackSet(packs);
  for(const pack of packs)for(const[table,rows]of recordGroups(pack))for(const row of rows){
    const current=store.get<any>(table,row.id);
    if(current&&semantic(current,table)!==semantic(row,table))throw new Error(`本地ID存在不同内容：${table}/${row.id}；请使用分享导入预览重映射`);
  }
}
export function validatePack(raw:any) {
  if(raw.schemaVersion!==1||!Array.isArray(raw.questions)||!raw.questions.length)throw new Error('Invalid content pack');
  const categories=new Map<string,any>(),tags=new Map<string,any>(),domains=new Set<string>();
  const domainRecords=raw.domains.map((d:any)=>({...domainSchema.parse(d),id:idSchema.parse(d.id)}));
  for(const d of domainRecords){if(domains.has(d.id))throw new Error('Duplicate domain');domains.add(d.id);}
  for(const source of raw.categories){const c={...categorySchema.parse(source),id:idSchema.parse(source.id)};if(categories.has(c.id)||!domains.has(c.domainId))throw new Error('Invalid category');categories.set(c.id,c);}
  for(const source of raw.tags){
    const t={...tagSchema.parse(source),id:idSchema.parse(source.id)};
    if(t.domainId===undefined){const uses=raw.questions.filter((q:any)=>q.tagIds?.includes(t.id));const related=new Set<string>(uses.flatMap((q:any)=>q.categoryIds.map((id:string)=>categories.get(id)?.domainId)));t.domainId=uses.length&&uses.every((q:any)=>q.categoryIds.length)&&related.size===1?[...related][0]!:null;}
    t.kind??='topic';
    if(tags.has(t.id)||t.domainId&&!domains.has(t.domainId))throw new Error('Invalid tag');tags.set(t.id,t);
  }
  for(const c of categories.values()){let at=c;const seen=new Set();while(at.parentId){if(seen.has(at.id))throw new Error('Category cycle');seen.add(at.id);const parent=categories.get(at.parentId);if(!parent||parent.domainId!==c.domainId)throw new Error('Invalid category parent');at=parent;}}
  const ids=new Set<string>();
  const questions=raw.questions.map((q:any)=>{
    const value=questionSchema.parse(q) as Question;
    if(!value.id||ids.has(value.id)||value.status!=='pending'||value.collection!=='general'||value.sourceDocument||Object.hasOwn(q,'resumePriority')||q.study)throw new Error('New content must be unique, generic and pending: '+value.id);
    if(!value.answerMarkdown.trim()||!value.explanationMarkdown.trim()||!value.categoryIds.length||!value.tagIds.length||!value.sourceRefs.length)throw new Error('Incomplete question: '+value.id);
    const questionDomains=new Set(value.categoryIds.map(id=>categories.get(id)?.domainId));
    if(value.categoryIds.some(id=>!categories.has(id))||value.tagIds.some(id=>!tags.has(id)||tags.get(id).domainId&&!questionDomains.has(tags.get(id).domainId)))throw new Error('Invalid taxonomy: '+value.id);
    ids.add(value.id);return value;
  });
  const banks=(raw.questionBanks||[]).map((b:any)=>({...questionBankSchema.parse(b),id:idSchema.parse(b.id)}));
  const bankIds=new Set<string>();for(const b of banks){if(bankIds.has(b.id)||b.questionIds.some((id:string)=>!ids.has(id)))throw new Error('Invalid bank');bankIds.add(b.id);}
  for(const q of questions)mapStrings(q,body=>{for(const link of body.matchAll(/(?:^|[\s("'<>])#\/questions\/([^/\s?#"'()<>\]]+)/g))if(!ids.has(decodeURIComponent(link[1])))throw new Error('Broken related-word link: '+q.id+' -> '+link[1]);return body;});
  for(const key of ['documents','papers','study','reviews','attempts','settings','paperDrafts','ai_settings','ai_runs'])if(raw[key]?.length||raw[key]&&!Array.isArray(raw[key]))throw new Error('Private state is forbidden: '+key);
  return enrichKnowledgePack({schemaVersion:1,generatedAt:raw.generatedAt,domains:domainRecords,categories:[...categories.values()],tags:[...tags.values()],questions,documents:[],papers:[],assets:(raw.assets||[]).map((a:any)=>assetRecordSchema.parse(a)),questionBanks:banks});
}
export function wordlistPapers(pack:any,size=100) {
  const lang=pack.domains.some((d:any)=>d.id==='english')?'english':pack.domains.some((d:any)=>d.id==='japanese')?'japanese':null;
  if(!lang)return [];
  const words=pack.questions.filter((q:Question)=>q.type==='short_answer'&&/^EN-V-|^JA-V-/.test(q.id));
  const output=[];
  for(let start=0;start<words.length;start+=size){
    const snapshot=words.slice(start,start+size),index=String(output.length+1).padStart(3,'0');
    const practiceKind=snapshot.every((q:Question)=>q.type==='short_answer'&&q.vocabulary&&vocabularyPromptIsSafe(q.vocabulary))?'vocabulary' as const:'standard' as const;
    output.push({id:`wordlist-${lang}-${index}`,title:`${lang==='english'?'英语':'日语'}单词表 ${index}（${snapshot.length}词）`,description:practiceKind==='vocabulary'?'无分词汇题集。先审核来源词条，再恢复题集；开始练习时选择看单词想释义或看释义想单词。空白卷用于默写，附答案卷用于查阅。':'无分词汇复习。先审核来源词条，再恢复题集；空白卷用于默写，附答案卷用于查阅。',mode:'manual' as const,practiceKind,questionIds:snapshot.map((q:Question)=>q.id),questionCount:snapshot.length,filters:null,archived:true,version:1,organization:'domain' as const,domainId:lang,createdAt:stamp,updatedAt:stamp,snapshot,scoring:normalizeScoring(snapshot,{enabled:false})});
  }
  return output;
}
export function asShare(pack:any,title:string,questions=pack.questions,papers:any[]=[]) {
  const chosen=new Set(questions.map((q:Question)=>q.id));
  // A 500-question part is usable on its own. Relations outside that part stay
  // readable as words rather than becoming broken or incorrectly local links.
  const markdown=(value:string)=>value.replace(/\[([^\]]+)\]\(#\/questions\/([^/\s)"?#]+)(?:\?[^)\s"]*)?\)/g,(whole,label,target)=>chosen.has(decodeURIComponent(target))?whole:`${label}（关联词在其他分包）`).replace(/(^|[\s("'<>])#\/questions\/([^/\s?#"'()<>\]]+)(?:\?[^)\s"'<>\]]*)?/g,(whole,prefix,target)=>chosen.has(decodeURIComponent(target))?whole:`${prefix}#/questions?search=${encodeURIComponent(decodeURIComponent(target))}`);
  const records=questions.map((q:Question)=>mapStrings(q,markdown) as Question);
  const byId=new Map(records.map((q:Question)=>[q.id,q]));
  const snapshots=papers.map(p=>({...p,snapshot:p.snapshot.map((q:Question)=>byId.get(q.id))}));
  const banks=(pack.questionBanks||[]).flatMap((bank:any)=>{
    const questionIds=bank.questionIds.filter((id:string)=>chosen.has(id));
    if(!questionIds.length)return [];
    if(questionIds.length===bank.questionIds.length)return [{...bank,questionIds}];
    const suffix=sha(JSON.stringify(questionIds)).slice(0,16);
    return [{...bank,id:bank.id.slice(0,130)+'-part-'+suffix,name:bank.name.slice(0,150)+`（分包 ${suffix.slice(0,6)} · ${questionIds.length}题）`,description:`${bank.description||''}\n\n独立分享分包，包含原集合 ${bank.questionIds.length} 题中的 ${questionIds.length} 题。`,questionIds}];
  });
  return {format:'learning-share',schemaVersion:1,exportedAt:stamp,title,domains:pack.domains,categories:pack.categories,tags:pack.tags,assets:pack.assets||[],questions:records,papers:snapshots,questionBanks:banks};
}
async function loadPacks(selected:string[]) {
  const directory=join(root,'data/content-packs');
  const files=(await readdir(directory)).filter(name=>name.endsWith('.json')&&(!selected.length||selected.includes(name.slice(0,-5)))).sort();
  if(!files.length||selected.some(name=>!files.includes(name+'.json')))throw new Error('Unknown or missing content pack');
  return Promise.all(files.map(async name=>({name:name.slice(0,-5),file:join(directory,name),data:validatePack(JSON.parse(await readFile(join(directory,name),'utf8')))})));
}
export async function main(args=process.argv.slice(2)) {
  const mode=args.shift()||'validate',selected:string[]=[];let database=join(root,'data/noetic-atlas.sqlite');
  while(args.length){const argument=args.shift();if(argument==='--packs'){const value=args.shift();if(!value)throw new Error('--packs requires names');selected.push(...value.split(','));}else if(argument==='--database'){const value=args.shift();if(!value)throw new Error('--database requires a path');database=resolve(value);}else throw new Error('Unknown option '+argument);}
  if(!['validate','package','import'].includes(mode))throw new Error('Use validate, package or import');
  const packs=await loadPacks(selected);validatePackSet(packs.map(p=>p.data));const memory=new Store(':memory:');
  try {for(const pack of packs)importData(memory,pack.data);}finally{memory.db.close();}
  const summaries=packs.map(p=>({id:p.name,questions:p.data.questions.length,assets:p.data.assets.length,domains:p.data.domains.map((d:any)=>d.name),sha256:sha(JSON.stringify(p.data)),status:'pending'}));
  if(mode==='package'){
    const output=join(root,'artifacts/content');await mkdir(output,{recursive:true});
    const artifacts=[],bundleFiles:Array<{name:string;data:Buffer}>=[];
    for(const pack of packs){
      const papers=wordlistPapers(pack.data),wordDirectory=join(output,pack.name,'wordlists');
      await mkdir(join(output,pack.name),{recursive:true});
      // Keep each share below the HTTP body limit and avoid rendering 10,000
      // preview rows at once. Every part has complete taxonomy dependencies.
      for(let start=0;start<pack.data.questions.length;start+=500){
        const questions=pack.data.questions.slice(start,start+500),ids=new Set(questions.map((q:Question)=>q.id));
        const piecePapers=papers.filter(p=>p.questionIds.every((id:string)=>ids.has(id)));
        const filename=`${pack.name}/part-${String(start/500+1).padStart(3,'0')}.json`,value=JSON.stringify(asShare(pack.data,`${pack.name} · ${start+1}–${start+questions.length}`,questions,piecePapers));
        await writeFile(join(output,filename),value);artifacts.push({file:filename,questions:questions.length,bytes:Buffer.byteLength(value),sha256:sha(value)});bundleFiles.push({name:filename,data:Buffer.from(value)});
      }
      if(papers.length){await mkdir(wordDirectory,{recursive:true});for(const paper of papers){
        const doc=paperExportDocument(paper as any,'answers'),name=`${pack.name}/wordlists/${paper.id}.md`;await writeFile(join(output,name),doc.markdown);bundleFiles.push({name,data:Buffer.from(doc.markdown)});
      }}
    }
    async function collectNotices(directory:string,prefix:string){
      if(!existsSync(directory))return;
      for(const entry of await readdir(directory,{withFileTypes:true})){const name=prefix+'/'+entry.name,path=join(directory,entry.name);if(entry.isDirectory())await collectNotices(path,name);else bundleFiles.push({name,data:await readFile(path)});}
    }
    await collectNotices(join(root,'docs/licenses'),'licenses');
    await collectNotices(join(root,'data/content-sources'),'sources');
    const wordlists=packs.reduce((count,pack)=>count+wordlistPapers(pack.data).length,0);
    const coverage=summaries.map(pack=>`| ${pack.id} | ${pack.questions.toLocaleString('en-US')} | ${pack.assets} |`).join('\n');
    const notes=[];
    if(packs.some(p=>p.name==='english'))notes.push('英语含10000词和144道原创语法题；中英释义及例句全覆盖，具体句式/搭配73.08%，关联词98.96%。高考、四六级标签来自第三方历史词表，不保证现行考纲全覆盖。');
    if(packs.some(p=>p.name==='japanese'))notes.push('日语含10000词和132道原创语法题；其中上游N1标注2689词，另有其他级别/日常补充。中文释义与日中例句来自上游AI，尚未逐条人工核验。');
    if(packs.some(p=>p.name==='chinese'))notes.push('成语4365条，340条有较完整典故资料；缺完整典故4025条、缺拼音64条，均明确标记。');
    if(packs.some(p=>p.name.startsWith('driving')))notes.push('驾驶按车型/科目和来源组织。driving是383道法规学习/原创练习与17张自绘教学图；official包为官方公开的历史训练资料，含已过时规则，须核验后修改发布。官方上传日不等于有效版本，也不等于2026全国完整题库；来源未明示开放再分发许可，不另授予商业或无限制再分发许可。');
    if(packs.some(p=>p.name.startsWith('computer')))notes.push('计算机包含原有340道扩展题与两份各400道客观专项（以本次清单为准），优先增加单选、多选、判断与填空；基础应用另含1543道已审核通用题。');
    if(packs.some(p=>p.name.startsWith('chemistry')))notes.push('化学卡介绍名称、化学式、性质、代表反应与用途；区分纯物质、水合物、混合配方和聚合物重复单元，不将工业级与食品级混用。');
    if(packs.some(p=>p.name==='pharmacology'))notes.push('医学与药学按治疗类别组织60种常见活性成分，同一题同时关联化学分类，不重复存储。来源核验日2026-10-22，临床资料的地区和更新边界在题内保留，用户审核不等同于医学专家鉴定。');
    if(packs.some(p=>p.name.startsWith('terms-')))notes.push('术语卡含中文名、英文名称、常用缩写、定义、实例、相近概念辨析、误区及追问；按领域下的“术语与概念”和全局“术语概念”标签筛选。英文单词参考按词头在接收方查找，不依赖原题号；未导入相应英语词卡时显示缺失提示。普通词义和注明的词族参考不代替专业定义。化学、医学卡用于概念学习，不提供个人诊疗或危险操作方案。');
    const instructions=`# 认知星图可选学习内容

本次包含 ${summaries.reduce((n,p)=>n+p.questions,0).toLocaleString('en-US')} 条待审核通用题目与词条。此包不含应用程序、私人学习记录或AI凭据。数据来源与适用许可各不相同，请保留来源说明。

1. 解压ZIP；在“分享与导入”选择相应领域的 part-*.json，检查预览后确认。每份最多500题，可逐批导入。
2. 新题全部送待审核；按领域核对题干、答案、用例和标签，再由用户确认。重复导入不覆盖本地修改与审核状态。
3. 本次附 ${wordlists} 份无分单词表（每份至多100词）。词表初始归档；审核对应词条后恢复、调整和保存。各语言wordlists/中的Markdown可直接阅读。
4. 空白卷用于默写，附答案卷用于查阅；跨分包关联词保留可读词名，同包内关系可跳转。

## 本次包含范围

| 内容包 | 题目/词条 | 图片 |
| --- | ---: | ---: |
${coverage}

## 覆盖与审核说明

${notes.map(note=>'- '+note).join('\n')}

sources/*.json记录原始来源、版本、哈希与覆盖；licenses/与sources/下的NOTICE保留适用数据许可。分享时不要移除题内署名与授权说明。manifest.json与SHA256SUMS.txt校验文件完整性，不证明内容已审核正确。

大库完整JSON可能超过80MiB接口上限，请使用分包；迁移完整工作状态使用SQLite备份。
`;
    bundleFiles.push({name:'README.md',data:Buffer.from(instructions)});await writeFile(join(output,'README.md'),instructions);
    const manifest=JSON.stringify({generatedAt:new Date().toISOString(),reviewRequired:true,packs:summaries,artifacts,files:Object.fromEntries(bundleFiles.map(f=>[f.name,sha(f.data)]))},null,2);
    const sums=artifacts.map(a=>`${a.sha256}  ${a.file}`).join('\n')+'\n';
    await writeFile(join(output,'manifest.json'),manifest);await writeFile(join(output,'SHA256SUMS.txt'),sums);
    bundleFiles.push({name:'manifest.json',data:Buffer.from(manifest)},{name:'SHA256SUMS.txt',data:Buffer.from(sums)});
    // Plain ZIP for sharing: only this invocation's files, never user databases
    // or stale staging files from previous builds.
    const {createZip}=await import('../release/release-web.mjs');
    const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
    await mkdir(join(root,'artifacts/releases'),{recursive:true});
    const zip=createZip(bundleFiles,`noetic-atlas-content-${version}`),name=`noetic-atlas-${version}-content.zip`;
    await writeFile(join(root,'artifacts/releases',name),zip);
    await writeFile(join(output,'bundle.json'),JSON.stringify({file:`../releases/${name}`,bytes:zip.length,sha256:sha(zip)},null,2));
  }
  if(mode==='import'){
    if(!existsSync(database))throw new Error('先启动一次应用以初始化工作库，或指定已有 --database');
    const store=new Store(database);
    try {
      // Fail before writing if a local ID has a different meaning. The normal
      // sharing importer remains available for intentional collision remapping.
      assertImportCompatible(store,packs.map(p=>p.data));
      const backups=join(root,'data/backups');await mkdir(backups,{recursive:true});
      const backup=join(backups,`before-content-${Date.now()}.sqlite`);store.database.snapshotTo(backup);
      for(const pack of packs){const data={...pack.data,papers:wordlistPapers(pack.data)};const result=importData(store,data);console.log(JSON.stringify({pack:pack.name,result}));}
      console.log(JSON.stringify({backup:relative(root,backup),reviewRequired:true}));
    }finally{store.db.close();}
  }
  console.log(JSON.stringify({mode,packs:summaries},null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
