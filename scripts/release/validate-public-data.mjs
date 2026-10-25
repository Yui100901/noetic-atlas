import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

/** Positive field selection: even opaque non-provider tokens must not ship. */
export function validateBaseConfiguration(data) {
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  if(!exact(data,['format','schemaVersion','exportedAt','system','ai'])||data.format!=='noetic-atlas-configuration'||data.schemaVersion!==1||typeof data.exportedAt!=='string'||!Number.isFinite(Date.parse(data.exportedAt)))throw new Error('基础配置格式或字段无效');
  const cleanAi={enabled:false,baseUrl:'',model:'',supportsImages:false,sendImages:false,timeoutSeconds:60,maxTokens:4096};
  if(!exact(data.ai,Object.keys(cleanAi))||Object.entries(cleanAi).some(([key,value])=>data.ai[key]!==value))throw new Error('基础AI配置必须关闭、端点与模型为空且不含凭据');
  const numbers=['maxDraftsPerPaper','maxQuickDrafts','maxPaperDrafts','maxDocumentDrafts','examDurationMinutes','maxHistoryPerPaper','maxQuickHistory','maxQuestionHistory','randomQuestionCount','randomTotalPoints','objectivePercent','autosaveDebounceMs','maxDocumentMiB','maxImageMiB'];
  if(!exact(data.system,[...numbers,'theme','scoringEnabledByDefault','pointsByType','reviewIntervalsDays','dailyPush'])||numbers.some(key=>typeof data.system[key]!=='number'||!Number.isFinite(data.system[key]))||typeof data.system.scoringEnabledByDefault!=='boolean'||!['green','dark','pink','sky','mint'].includes(data.system.theme))throw new Error('基础系统配置含未知字段或非配置值');
  const cleanDaily={enabled:false,domainId:null,categoryIds:[],reviewPoints:30,newPoints:20,scheduleTime:'00:00',timeZone:'Asia/Shanghai'};
  if(!exact(data.system.dailyPush,Object.keys(cleanDaily))||Object.entries(cleanDaily).some(([key,value])=>JSON.stringify(data.system.dailyPush[key])!==JSON.stringify(value)))throw new Error('基础每日推题配置必须关闭且不含个人领域、分类或推题记录');
  const types=['short_answer','true_false','single_choice','multiple_choice','fill_blank','essay','group'];
  if(!exact(data.system.pointsByType,types)||types.some(key=>typeof data.system.pointsByType[key]!=='number'||!Number.isFinite(data.system.pointsByType[key]))||!Array.isArray(data.system.reviewIntervalsDays)||data.system.reviewIntervalsDays.length!==4||data.system.reviewIntervalsDays.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new Error('基础分值或复习配置无效');
  return {configuration:'clean-defaults',credentials:false,aiEnabled:false};
}

export function validatePublicData(seed) {
  if (seed.schemaVersion !== 1 || !['domains','categories','tags','questions','documents','papers'].every(key=>Array.isArray(seed[key]))) throw new Error('初始数据格式错误');
  const publicFields = new Set(['schemaVersion','generatedAt','domains','categories','tags','questions','documents','papers','questionBanks']);
  for (const key of Object.keys(seed)) if (!publicFields.has(key)) throw new Error(`发布题库包含非公开字段：${key}`);
  for (const question of seed.questions) {
    if (question.collection !== 'general' || question.status !== 'published' || Object.hasOwn(question,'resumePriority') || question.sourceDocument || question.sourceAnchor || question.study) throw new Error(`初装题目含个人状态或未审核内容：${question.id}`);
  }
  for (const key of ['documents','papers','attempts','study','reviews','settings','assets','paperDrafts','documentDrafts','ai_settings','ai_runs']) if (seed[key] !== undefined && (!Array.isArray(seed[key]) || seed[key].length)) throw new Error(`发布题库包含用户数据：${key}`);
  const domains = new Set(seed.domains.map(d=>d.id)), categories = new Map(seed.categories.map(c=>[c.id,c])), tags = new Map(seed.tags.map(t=>[t.id,t])), questions = new Set(seed.questions.map(q=>q.id));
  if (domains.size!==seed.domains.length || categories.size!==seed.categories.length || tags.size!==seed.tags.length || questions.size!==seed.questions.length) throw new Error('公开题库包含重复ID');
  for (const category of categories.values()) { if (!domains.has(category.domainId)) throw new Error('分类领域失效'); let current=category; const seen=new Set(); while(current?.parentId){ if(seen.has(current.id))throw new Error('分类形成环');seen.add(current.id);const parent=categories.get(current.parentId);if(!parent||parent.domainId!==category.domainId)throw new Error('分类祖先失效');current=parent;} }
  for (const tag of tags.values()) if(tag.domainId&&!domains.has(tag.domainId))throw new Error('标签领域失效');
  for (const q of seed.questions) { if(q.categoryIds.some(id=>!categories.has(id))||q.tagIds.some(id=>!tags.has(id)))throw new Error('题目引用失效'); }
  for (const bank of seed.questionBanks||[]) if (bank.questionIds.some(id=>!questions.has(id))) throw new Error('题库集合引用失效');
  const serialized = JSON.stringify(seed);
  if (/sk-[A-Za-z0-9]{20,}|[A-Z]:[\\/]+Users[\\/]+[^\\/"\s]+|PROJ-\d+/i.test(serialized)) throw new Error('发布题库包含凭据、本机路径或私人来源');
  return { questions: seed.questions.length, domains: seed.domains.length, categories: seed.categories.length, tags: seed.tags.length, personalQuestions: 0, userRecords: 0 };
}
export function createEmptyPublicData() {
  return {schemaVersion:1,domains:[],categories:[],tags:[],questions:[],questionBanks:[],documents:[],papers:[]};
}
export function validateEmptyInstall(data=createEmptyPublicData()) {
  const counts=validatePublicData(data);
  for(const key of ['domains','categories','tags','questions','questionBanks','documents','papers'])if(data[key]?.length)throw new Error(`软件须为空安装，不得内置数据：${key}`);
  return counts;
}
export const EMPTY_INSTALL_COUNTS=Object.freeze(validateEmptyInstall());
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify({...validateEmptyInstall(),...validateBaseConfiguration(JSON.parse(readFileSync(resolve('config/defaults.json'),'utf8')))}));
