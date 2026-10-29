import { readOnlyOperation } from '../../http/operation.js';
import {normalizeQuestionBlankStems} from '../../../shared/questions/blank-markers.js';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Category, Domain, Question, Tag } from '../../../shared/models/types.js';
import type { SharePackage, SharePreview, ShareSelection } from '../../../shared/models/sharing.js';
import { type AssetRecord } from '../../../shared/assets/assets.js';
import { Store, makeId, now, type Table } from '../../core/store.js';
import { id, parse, fail, domainSchema, categorySchema, tagSchema, questionSchema, questionBankSchema, storedScoringSchema, filtersSchema, types } from '../../core/validation.js';
import { assetRecordSchema, validateAssetRecord } from '../assets/schema.js';
import { collectAssetReferences, validateAssetReferences } from '../assets/service.js';
import { type StoredPaper, QUICK_PAPER_ID } from '../practice/service.js';
import { resolveConceptQuestion, validateConceptPaperSnapshot } from '../practice/concept-practice.js';
import { resolveVocabularyQuestion, validateVocabularyPaperSnapshot } from '../practice/vocabulary-practice.js';
import { normalizeScoring } from '../practice/scoring.js';
import { validatePaperAnswers } from '../questions/structure.js';
import { paperExportDocument } from '../transfer/exports.js';
import { getSettings } from '../settings/service.js';
import { legacyBankPaper } from '../banks/legacy-banks.js';

const selectionSchema = z.object({ kind: z.enum(['questions', 'paper']), id: id.optional(), ids: z.array(id).min(1).max(50000).optional(), filters: z.record(z.string(), z.unknown()).optional() }).strict();
const flag=z.union([z.boolean(),z.enum(['true','false','1','0'])]);
const shareFiltersSchema=filtersSchema.safeExtend({search:z.string().max(1000).optional(),type:types.optional(),difficulty:z.coerce.number().int().min(1).max(4).optional(),depth:z.coerce.number().int().min(1).max(4).optional(),frequency:z.coerce.number().int().min(0).max(3).optional(),status:z.enum(['published','pending','draft','archived','all']).optional(),favorite:flag.optional(),wrong:flag.optional(),due:flag.optional()}).strict();
function shareFilters(raw:Record<string,unknown>={}) {
  const input=Object.fromEntries(Object.entries(raw).filter(([,value])=>value!==''&&value!==undefined&&value!==null));
  if(typeof input.tagIds==='string')input.tagIds=input.tagIds.split(',').filter(Boolean);
  return parse(shareFiltersSchema,input);
}
const shareQuestion = questionSchema.safeExtend({ id });
const paperSchema = z.object({ id, title: z.string().min(1).max(300), description: z.string().max(500000), mode: z.enum(['manual','random']), practiceKind: z.enum(['standard','vocabulary','concept']).optional(), legacyBankId: id.optional(), questionIds: z.array(id).max(50000), questionCount: z.number().int().min(0).max(50000), archived: z.boolean(), version: z.number().int().min(1), createdAt: z.string().datetime({offset:true}), updatedAt: z.string().datetime({offset:true}), scoring: storedScoringSchema.optional(), snapshot: z.array(shareQuestion).max(50000), organization: z.enum(['domain','other']).optional(), domainId: id.nullable().optional(), filters: z.null().default(null) }).strict();
const packageSchema = z.object({ format: z.literal('learning-share'), schemaVersion: z.literal(1), exportedAt: z.string().datetime({offset:true}), title: z.string().min(1).max(300), domains: z.array(domainSchema.extend({id})).max(10000), categories: z.array(categorySchema.extend({id})).max(50000), tags: z.array(tagSchema.extend({id})).max(50000), assets: z.array(assetRecordSchema).max(10000), questions: z.array(shareQuestion).max(50000), papers: z.array(paperSchema).max(100), questionBanks: z.array(questionBankSchema.safeExtend({id})).max(100).default([]) }).strict();
const cleanQuestion = (question: Question): Question => { const { study: _study, ...record } = question; return { ...record, sourceDocument: null, sourceAnchor: null }; };
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([key,entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`; return JSON.stringify(value); }
function fingerprint(store: Store) { return createHash('sha256').update(canonical(['domains','categories','tags','assets','questions','papers','question_banks'].map(table => store.all(table as Table)))).digest('hex'); }
function semantic(value: any, table: Table) {
  const { id: _id, createdAt: _created, updatedAt: _updated, study: _study, ...record } = value;
  if (table === 'questions') { delete record.status; record.sourceDocument = null; record.sourceAnchor = null; }
  if (table === 'papers') {
    record.practiceKind ||= 'standard';
    // Archive/review/version transitions belong to the recipient. Reimporting
    // the same frozen paper must not undo them or create another copy.
    delete record.archived; delete record.version;
    record.snapshot = record.snapshot?.map((question:Question) => ({ id:question.id, ...JSON.parse(semantic(question,'questions')) }));
  }
  if (table === 'domains' || table === 'categories') delete record.sortOrder;
  return canonical(record);
}

/** Hash routes in rich text are references, just like category/asset IDs. */
function mapQuestionLinks(value:any, map:(qid:string)=>string):any {
  if(typeof value==='string') return value.replace(/(^|[\s("'<>])#\/questions\/([^/\s?#"'()<>\]]+)/g,(_match,prefix:string,encoded:string)=>{
    let qid=encoded;try{qid=decodeURIComponent(encoded);}catch{/* Keep malformed text inert through the caller's fallback. */}
    return `${prefix}${map(qid)}`;
  });
  if(Array.isArray(value))return value.map(item=>mapQuestionLinks(item,map));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapQuestionLinks(item,map)]));
  return value;
}
const questionRoute=(qid:string)=>`#/questions/${encodeURIComponent(qid)}`;
function questionLinks(value:any):string[] {
  const links:string[]=[];
  // Canonical key order also makes edge positions independent of JSON field order.
  function visit(item:any):void {
    if(typeof item==='string'){mapQuestionLinks(item,qid=>{links.push(qid);return questionRoute(qid);});return;}
    if(Array.isArray(item)){for(const child of item)visit(child);return;}
    if(item&&typeof item==='object')for(const key of Object.keys(item).sort((a,b)=>a.localeCompare(b)))visit(item[key]);
  }
  visit(value);return links;
}
const questionCore=(question:Question)=>semantic(mapQuestionLinks(question,()=>questionRoute('__share_reference__')),'questions');
const linkedQuestionSemantic=(question:Question)=>semantic(mapQuestionLinks(question,questionRoute),'questions');

/**
 * Resolve all question IDs before rewriting links. A candidate's complete link
 * graph must match: ignoring URL IDs alone could reuse a card that points to a
 * different question. Trying a candidate forces its referenced source nodes to
 * the corresponding local targets; cycles are handled by the tentative map.
 * No recursion and no repeated scans of the question table are needed.
 */
function questionImportTargets(existing:Question[],incoming:Question[]) {
  const local=new Map(existing.map(q=>[q.id,q])),source=new Map(incoming.map(q=>[q.id,q]));
  const cores=new Map<string,string>(),edges=new Map<string,string[]>(),index=new Map<string,Question[]>();
  for(const q of existing){const core=questionCore(q);cores.set(q.id,core);edges.set(q.id,questionLinks(JSON.parse(semantic(q,'questions'))));const bucket=index.get(core)||[];bucket.push(q);index.set(core,bucket);}
  const sourceCores=new Map(incoming.map(q=>[q.id,questionCore(q)]));
  const sourceEdges=new Map(incoming.map(q=>[q.id,questionLinks(JSON.parse(semantic(q,'questions')))]));
  const fresh=new Map(incoming.map(q=>[q.id,local.has(q.id)||['new','review','import','import-template'].includes(q.id)?makeId('share-questions'):q.id]));
  const targets=new Map<string,string>(),owners=new Map<string,string>();
  function tryCandidate(qid:string,target:string):Map<string,string>|null {
    const trial=new Map<string,string>(),trialOwners=new Map<string,string>(),stack:Array<[string,string]>=[[qid,target]];
    while(stack.length){
      const [sid,tid]=stack.pop()!;
      const assigned=targets.get(sid)??trial.get(sid);if(assigned!==undefined){if(assigned!==tid)return null;continue;}
      const owner=owners.get(tid)??trialOwners.get(tid);if(owner!==undefined&&owner!==sid)return null;
      if(!source.has(sid))return null;
      trial.set(sid,tid);trialOwners.set(tid,sid);
      const candidate=local.get(tid);
      if(!candidate){if(fresh.get(sid)!==tid)return null;continue;}
      if(cores.get(tid)!==sourceCores.get(sid))return null;
      const from=sourceEdges.get(sid)!,to=edges.get(tid)!;
      if(from.length!==to.length)return null;
      for(let i=0;i<from.length;i++)stack.push([from[i]!,to[i]!]);
    }
    return trial;
  }
  for(const question of incoming){
    if(targets.has(question.id))continue;
    const candidates=index.get(sourceCores.get(question.id)!)||[];
    // Original-ID matches are preferred, but semantically equal renamed copies
    // remain candidates for repeat imports after an earlier ID collision.
    const current=local.get(question.id);
    const ordered=current&&cores.get(current.id)===sourceCores.get(question.id)?[current,...candidates.filter(q=>q.id!==current.id)]:candidates;
    let match:Map<string,string>|null=null;
    for(const candidate of ordered){if(owners.has(candidate.id))continue;match=tryCandidate(question.id,candidate.id);if(match)break;}
    match ||= tryCandidate(question.id,fresh.get(question.id)!);
    if(!match)fail(400,'INVALID_SHARE_LINK_GRAPH','分享题目关联关系无法安全映射');
    for(const [sid,tid]of match!){targets.set(sid,tid);owners.set(tid,sid);}
  }
  // Final exact comparison is a safety check, not a lossy URL-normalized reuse.
  for(const question of incoming){
    const target=targets.get(question.id)!,candidate=local.get(target);if(!candidate)continue;
    const rewritten=mapQuestionLinks(question,qid=>questionRoute(targets.get(qid)!));
    if(linkedQuestionSemantic(rewritten)!==linkedQuestionSemantic(candidate))fail(400,'INVALID_SHARE_LINK_GRAPH','关联题完整内容与复用目标不一致');
  }
  return targets;
}
function assertUnique(entries: Array<{id:string}>, table: string) { if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail(400, 'DUPLICATE_SHARE_ID', `分享包含重复ID：${table}`); }

export function exportShare(store: Store, selection: ShareSelection): SharePackage {
  let questions: Question[] = []; let papers: StoredPaper[] = []; let title = '分享题目';
  if (selection.kind === 'paper') {
    const paper = store.require<StoredPaper>('papers', selection.id || fail(400, 'SHARE_SELECTION_REQUIRED', '请选择题集'));
    const snapshot = paper.snapshot.map(question => cleanQuestion(paper.practiceKind === 'vocabulary' ? resolveVocabularyQuestion(store, question) : paper.practiceKind === 'concept' ? resolveConceptQuestion(store, question) : question));
    papers = [{ ...paper, filters: null, snapshot }]; questions = snapshot; title = paper.title;
  } else {
    questions = selection.ids?.length ? selection.ids.map(qid => cleanQuestion(store.require<Question>('questions', qid))) : store.questions(shareFilters(selection.filters)).map(cleanQuestion);
    title = questions.length === 1 ? questions[0]!.title : `分享题目（${questions.length}道）`;
  }
  if (!questions.length && !papers.length) fail(422, 'EMPTY_SHARE', '当前范围没有可分享的题目');
  assertUnique(questions, 'questions');
  const categories = new Map(store.all<Category>('categories').map(category => [category.id, category])); const categoryIds = new Set(questions.flatMap(question => question.categoryIds));
  for (const cid of categoryIds) { let parent = categories.get(cid)?.parentId; const seen = new Set([cid]); while (parent) { if (seen.has(parent)) fail(400,'CATEGORY_CYCLE','分类不能形成环'); seen.add(parent); categoryIds.add(parent); parent = categories.get(parent)?.parentId; } }
  const tagIds = new Set(questions.flatMap(question => question.tagIds)); const tags = [...tagIds].map(tid => store.require<Tag>('tags', tid));
  const chosenCategories = [...categoryIds].map(cid => store.require<Category>('categories', cid)); const domainIds = new Set([...chosenCategories.map(category => category.domainId), ...tags.flatMap(tag => tag.domainId ? [tag.domainId] : []), ...papers.flatMap(paper => paper.domainId ? [paper.domainId] : [])]);
  const assets = [...collectAssetReferences({ questions, papers })].map(aid => store.require<AssetRecord>('assets', aid));
  return { format:'learning-share', schemaVersion:1, exportedAt:now(), title, domains:[...domainIds].map(did => store.require<Domain>('domains', did)), categories:chosenCategories, tags, assets, questions, papers, questionBanks:[] };
}

/** Build the whole graph before writing. ID collisions never overwrite local data. */
export function planShareImport(store: Store, raw: unknown) {
  const data = parse(packageSchema, raw) as SharePackage;
  for (const [key, entries] of Object.entries({domains:data.domains,categories:data.categories,tags:data.tags,assets:data.assets,questions:data.questions,papers:data.papers,question_banks:data.questionBanks})) assertUnique(entries, key);
  const sourceQuestions = new Map(data.questions.map(question => [question.id, question]));
  // Older share files may contain reference collections. Fold them into the
  // same paper graph before ID remapping; never emit or stage a second kind.
  const occupiedPaperIds = new Set(data.papers.map(paper => paper.id));
  for (const bank of data.questionBanks) {
    let paperId = bank.id;
    if (occupiedPaperIds.has(paperId) || ['new', 'preview', QUICK_PAPER_ID].includes(paperId)) {
      const base = `legacy-bank-${createHash('sha256').update(bank.id).digest('hex').slice(0, 24)}`;
      paperId = base; let suffix = 1;
      while (occupiedPaperIds.has(paperId)) paperId = `${base}-${suffix++}`;
    }
    occupiedPaperIds.add(paperId);
    data.papers.push(legacyBankPaper(bank, bank.questionIds.map(qid => sourceQuestions.get(qid) || fail(400, 'INCOMPLETE_SHARE', `分享包缺少题目：${qid}`)), paperId));
  }
  data.questionBanks = [];
  const counts: SharePreview['counts'] = {}; const records: Array<{ table:Table; value:any }> = []; const maps = new Map<Table, Map<string,string>>();
  // Vocabulary packs contain thousands of entries. Index each table once;
  // rescanning and reparsing every existing question for every incoming word
  // makes otherwise valid imports quadratic.
  const semanticIndexes = new Map<Table,Map<string,any[]>>();
  const staged = new Map<Table,Map<string,any>>();
  const claimedQuestions = new Set<string>();
  const pendingQuestions = new Set<string>();
  const candidateOffsets = new Map<string,number>();
  function semanticIndex(table:Table) {
    if(!semanticIndexes.has(table)){
      const index=new Map<string,any[]>();
      for(const value of store.all<any>(table)){const signature=semantic(value,table);const bucket=index.get(signature)||[];bucket.push(value);index.set(signature,bucket);}
      semanticIndexes.set(table,index);
    }
    return semanticIndexes.get(table)!;
  }
  const mapFor = (table:Table) => { if (!maps.has(table)) maps.set(table,new Map()); return maps.get(table)!; };
  function ref(table:Table, source:string) { const target = mapFor(table).get(source); if (!target) fail(400, 'INCOMPLETE_SHARE', `分享包缺少依赖：${table}/${source}`); return target!; }
  function assign(table:Table, source:any, transformed:any, forcedTarget?:string) {
    const current = store.get<any>(table,source.id); const signature = semantic(transformed,table);
    const index=forcedTarget===undefined?semanticIndex(table):null,candidates=index?.get(signature)||[];
    let offset=table==='questions'?candidateOffsets.get(signature)||0:0;
    if(table==='questions')while(offset<candidates.length&&claimedQuestions.has(candidates[offset].id))offset++;
    if(table==='questions')candidateOffsets.set(signature,offset);
    const same = forcedTarget!==undefined?store.get<any>(table,forcedTarget):current && (table!=='questions'||!claimedQuestions.has(current.id)) && semantic(current,table) === signature ? current : candidates[offset];
    const reserved = table === 'questions' ? ['new','review','import','import-template'].includes(source.id) : table === 'papers' ? ['new','preview',QUICK_PAPER_ID].includes(source.id) : table === 'question_banks' && ['new'].includes(source.id);
    const target = forcedTarget || same?.id || (current || reserved ? makeId(`share-${table}`) : source.id); mapFor(table).set(source.id,target);
    const count = counts[table] ||= {added:0,reused:0,remapped:0}; if (target !== source.id) count.remapped++;
    if (same) count.reused++; else {
      count.added++;const value={...transformed,id:target};records.push({table,value});
      if(!staged.has(table))staged.set(table,new Map());staged.get(table)!.set(target,value);
      candidates.push(value);index?.set(signature,candidates);
      if(table==='questions')pendingQuestions.add(target);
    }
    if(table==='questions')claimedQuestions.add(target);
    return target;
  }
  const rewrite = (value:any):any => {
    if (typeof value === 'string') return value.replace(/\/api\/assets\/([^/\s?#"'()<>\]]+)\/(content|data)/g, (_match, aid:string, route:string) => `/api/assets/${encodeURIComponent(ref('assets', decodeURIComponent(aid)))}/${route}`);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,entry]) => [key,rewrite(entry)]));
    return value;
  };
  for (const domain of data.domains) assign('domains',domain,domain);
  const pending = [...data.categories]; while (pending.length) { const index = pending.findIndex(category => !category.parentId || mapFor('categories').has(category.parentId)); if (index < 0) fail(400,'CATEGORY_CYCLE','分享分类有环或缺少父分类'); const category = pending.splice(index,1)[0]!; assign('categories',category,{...category,domainId:ref('domains',category.domainId),parentId:category.parentId ? ref('categories',category.parentId) : null}); }
  for (const tag of data.tags) assign('tags',tag,{...tag,domainId:tag.domainId ? ref('domains',tag.domainId) : null,kind:tag.kind || 'custom'});
  for (const asset of data.assets) { validateAssetRecord(asset,getSettings(store)); assign('assets',asset,asset); }
  const sourceQuestionIds=new Set(data.questions.map(question=>question.id));
  let detachedQuestionLinks=false;
  const transformedQuestions=data.questions.map(question=>{
    const transformed={...normalizeQuestionBlankStems(rewrite(cleanQuestion(question))),categoryIds:[...new Set(question.categoryIds.map(cid=>ref('categories',cid)))],tagIds:[...new Set(question.tagIds.map(tid=>ref('tags',tid)))],status:'pending',createdAt:now(),updatedAt:now()};
    // A package may contain one card whose related card is in another part.
    // Without the related content we cannot establish identity. A search link
    // is explicit and safe; retaining the old detail route could open an
    // unrelated local question with the same foreign ID.
    return mapQuestionLinks(transformed,qid=>{if(sourceQuestionIds.has(qid))return questionRoute(qid);detachedQuestionLinks=true;return `#/questions?search=${encodeURIComponent(qid)}`;}) as Question;
  });
  const questionTargets=questionImportTargets(store.all<Question>('questions'),transformedQuestions);
  for(const [source,target]of questionTargets)mapFor('questions').set(source,target);
  for(let i=0;i<data.questions.length;i++){
    const question=data.questions[i]!,transformed=mapQuestionLinks(transformedQuestions[i],qid=>questionRoute(ref('questions',qid)));
    assign('questions',question,parse(shareQuestion,transformed),questionTargets.get(question.id));
  }
  for (const paper of data.papers) {
    if (paper.id === QUICK_PAPER_ID) fail(400,'RESERVED_PAPER_ID','分享题集ID无效');
    if (paper.questionIds.length !== paper.snapshot.length || paper.snapshot.some((question,index)=>question.id !== paper.questionIds[index]) || paper.questionCount !== paper.questionIds.length) fail(400,'INVALID_SNAPSHOT','分享题集快照快照与题号不一致');
    for (const question of paper.snapshot) if (semantic(question,'questions') !== semantic(sourceQuestions.get(question.id) || fail(400,'INCOMPLETE_SHARE','题集快照快照题目未包含在分享包中'),'questions')) fail(400,'INVALID_SNAPSHOT','题集快照快照和分享题目内容不一致');
    const snapshot = paper.snapshot.map(question=>{
      const target=ref('questions',question.id),resolved=staged.get('questions')?.get(target)||store.require<Question>('questions',target);
      // The source snapshot was checked above. Reuse the exact transformed
      // content (including remapped links) and the recipient's review state.
      return {...resolved,id:target};
    }) as Question[];
    const questionPoints = paper.scoring ? Object.fromEntries(Object.entries(paper.scoring.questionPoints).map(([qid,points])=>[ref('questions',qid),points])) : undefined;
    const scoring = normalizeScoring(snapshot,paper.scoring ? {...paper.scoring,questionPoints} : undefined); validatePaperAnswers(snapshot, 1_500_000);
    if (paper.practiceKind === 'vocabulary') validateVocabularyPaperSnapshot(snapshot);
    if (paper.practiceKind === 'concept') validateConceptPaperSnapshot(snapshot);
    const pendingQuestions = snapshot.some(question => store.get<Question>('questions',question.id)?.status !== 'published');
    const domainId = paper.domainId ? ref('domains',paper.domainId) : null; if (paper.organization === 'domain' && !domainId) fail(400,'PAPER_DOMAIN_REQUIRED','领域专项题集缺少领域');if((paper.organization||'other')==='other'&&domainId)fail(400,'PAPER_DOMAIN_MISMATCH','其他题集不能指定领域');
    assign('papers',paper,{...paper, snapshot, scoring,questionIds:snapshot.map(question=>question.id), mode:'manual',filters:null,archived:paper.archived||pendingQuestions,organization:paper.organization || 'other',domainId,createdAt:now(),updatedAt:now()});
  }
  // Validate against a read-only merged view. Preview has exactly the same
  // dependency and media checks as import, without touching SQLite rows.
  const merged = Object.create(store) as Store;
  merged.get = <T=any>(table:Table,entityId:string):T|undefined => (staged.get(table)?.get(entityId) as T|undefined) || store.get<T>(table,entityId);
  merged.all = <T=any>(table:Table):T[] => [...store.all<T>(table),...records.filter(record=>record.table===table).map(record=>record.value as T)];
  for(const record of records) {
    if(record.table==='categories') merged.validateCategory(record.value);
    if(record.table==='tags') merged.validateTag(record.value);
    if(record.table==='questions') merged.validateRefs(record.value);
    if(record.table==='questions'||record.table==='papers') validateAssetReferences(merged,record.value,getSettings(store));
  }
  const preview:SharePreview = {title:data.title,counts,questions:data.questions.map(question=>({id:ref('questions',question.id),title:question.title,status:pendingQuestions.has(ref('questions',question.id))?'pending':'reused'})),warnings:['分享包不含学习记录、笔记、作答、系统配置或AI凭据。','新增题目统一进入待审核；复用已存在且内容相同的题目时保留本地审核状态。',...(data.papers.length ? ['含待审核题目的题集先归档，审核题目后从“恢复并调整”保存，即可练习；重复导入保留本地归档状态、题集快照与分值。'] : []),...(detachedQuestionLinks?['未随本包附带的关联题详情链接已改为题号搜索，避免误指本地同ID题目；可从来源资料继续核对。']:[])],fingerprint:fingerprint(store)};
  return {records,preview};
}
export function importShare(store:Store,raw:unknown,expectedFingerprint?:string) {
  return store.transaction(()=>{ const plan = planShareImport(store,raw); if (expectedFingerprint && expectedFingerprint !== plan.preview.fingerprint) fail(409,'SHARE_PREVIEW_STALE','本地题库已变化，请重新预览后导入'); for (const record of plan.records) store.insert(record.table,record.value.id,record.value); for (const category of store.all<Category>('categories')) store.validateCategory(category); store.validateTaxonomyReferences(); for (const record of plan.records) if (record.table === 'questions' || record.table === 'papers') validateAssetReferences(store,record.value); return {ok:true,...plan.preview}; });
}
export function registerSharingRoutes(app:FastifyInstance,store:Store) {
  app.post('/api/sharing/export', readOnlyOperation,async request=>exportShare(store,parse(selectionSchema,request.body)));
  app.post('/api/sharing/preview', readOnlyOperation,async request=>planShareImport(store,parse(z.object({data:z.unknown()}).strict(),request.body).data).preview);
  app.post('/api/sharing/import',async request=>{const input=parse(z.object({data:z.unknown(),confirmed:z.literal(true),expectedFingerprint:z.string().length(64).optional()}).strict(),request.body); return importShare(store,input.data,input.expectedFingerprint);});
  app.post('/api/sharing/export-document', readOnlyOperation,async request=>{ const input=parse(selectionSchema,request.body); if(input.kind === 'paper') { const paper=store.require<StoredPaper>('papers',input.id || fail(400,'SHARE_SELECTION_REQUIRED','请选择题集')); if(paper.questionCount>500)fail(422,'SHARE_PDF_LIMIT','PDF单次最多500道题，请缩小范围或使用JSON分享'); return paperExportDocument(paper,'answers'); } const data=exportShare(store,input); if(data.questions.length > 500) fail(422,'SHARE_PDF_LIMIT','PDF单次最多500道题，请缩小范围或使用JSON分享'); const snapshot=data.questions; const stamp=now(); return paperExportDocument({id:'share-export',title:data.title,description:'题目分享 · 含参考答案与解析',mode:'manual',questionIds:snapshot.map(question=>question.id),questionCount:snapshot.length,filters:null,archived:false,version:1,createdAt:stamp,updatedAt:stamp,snapshot,scoring:normalizeScoring(snapshot,{enabled:false})},'answers'); });
}
