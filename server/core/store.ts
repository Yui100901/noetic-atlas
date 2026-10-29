import { DatabaseConnection } from '../database/connection.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Question, QuestionBank, QuestionPage, Category, Domain, Tag, DocumentRecord, StudyState, Paper, Attempt } from '../../shared/models/types.js';
import { fail } from './validation.js';
import { cleanLearningRecord } from '../../shared/questions/learning-records.js';
import { QuestionQueries, type QuestionSelection } from '../modules/questions/queries.js';
import { emptyStudy, studyPartKey } from '../../shared/questions/study-state.js';
import type { DocumentDraft } from '../../shared/models/document-drafts.js';
import { enrichQuestionsWithFeedback } from '../modules/quality-feedback/service.js';

export type Entity = Domain | Category | Tag | Question | QuestionBank | DocumentRecord | StudyState | Paper | Attempt;
export const tables = ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'attempts', 'study', 'study_parts', 'learning_results', 'question_history', 'reviews', 'review_cards', 'review_events', 'question_banks', 'settings', 'assets', 'paper_drafts', 'document_drafts', 'ai_workspace_drafts', 'daily_pushes', 'question_feedback', 'quality_scans', 'quality_issues'] as const;
export type Table = typeof tables[number];
export const now = () => new Date().toISOString();
export const nextStamp = (previous?: string) => new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
export const makeId = (prefix: string) => `${prefix}-${randomUUID()}`;

export class Store {
  readonly database: DatabaseConnection;
  /** Backwards-compatible handle for offline maintenance/tests. */
  readonly db: DatabaseConnection;
  private readonly questionQueries:QuestionQueries;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = this.db = new DatabaseConnection(path);
    this.questionQueries=new QuestionQueries(this.database);
  }
  all<T = any>(table: Table): T[] { return this.database.records<T>(table).map(record => cleanLearningRecord(table,record)); }
  get<T = any>(table: Table, id: string): T | undefined { const value=this.database.getRecord<T>(table,id);return value===undefined?undefined:cleanLearningRecord(table,value); }
  require<T = any>(table: Table, id: string): T { return this.get<T>(table, id) ?? fail(404, 'NOT_FOUND', '记录不存在'); }
  put(table: Table, id: string, data: unknown) { this.database.putRecord(table,id,cleanLearningRecord(table,data)); }
  insert(table: Table, id: string, data: unknown) { if (this.get(table, id)) fail(409, 'ID_EXISTS', 'ID 已存在'); this.put(table, id, data); }
  remove(table: Table, id: string) { this.require(table, id);this.database.deleteRecord(table,id); }
  transaction<T>(fn: () => T): T { return this.database.transaction(fn); }
  taxonomy() { return { domains: this.all<Domain>('domains').sort((a, b) => a.sortOrder - b.sortOrder), categories: this.all<Category>('categories').sort((a, b) => a.sortOrder - b.sortOrder), tags: this.all<Tag>('tags').sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) }; }
  normalizeLegacyTags() {
    // Run only on absent fields. Explicit global scope must remain global,
    // including after questions are edited or more domains are imported.
    const legacyTags = this.all<Tag>('tags').filter(tag => tag.domainId === undefined || tag.kind === undefined);
    if (!legacyTags.length) return;
    const legacyIds = new Set(legacyTags.map(tag => tag.id));
    const categories = new Map(this.all<Category>('categories').map(c => [c.id, c.domainId]));
    const usedDomains = new Map<string, Set<string>>();
    const unclassifiedUses = new Set<string>();
    for (const record of this.taxonomyReferenceMetadata()) {
      for (const tid of record.tagIds) {
        if (!legacyIds.has(tid)) continue;
        if (!record.categoryIds.length) unclassifiedUses.add(tid);
        const domains = usedDomains.get(tid) || new Set<string>();
        for (const cid of record.categoryIds) { const did = categories.get(cid); if (did) domains.add(did); }
        usedDomains.set(tid, domains);
      }
    }
    for (const tag of legacyTags) {
      const domains = usedDomains.get(tag.id) || new Set<string>();
      const domainId = tag.domainId === undefined ? domains.size === 1 && !unclassifiedUses.has(tag.id) ? [...domains][0]! : null : tag.domainId;
      this.put('tags', tag.id, { ...tag, domainId, kind: tag.kind || 'topic' });
    }
  }
  validateTag(tag: Tag) {
    this.validateTagReference(tag, domainId => Boolean(this.get('domains', domainId)));
  }
  private validateTagReference(tag: Tag, hasDomain: (id: string) => boolean) {
    if (tag.domainId && !hasDomain(tag.domainId)) fail(400, 'INVALID_REFERENCE', '标签所属领域不存在');
    if (tag.kind === 'method' && tag.domainId) fail(400, 'METHOD_TAG_GLOBAL', '学习方式标签应为全局标签；领域知识主题请使用主题或自定义类型');
  }
  validateRefs(record: { categoryIds: string[]; tagIds: string[]; domainIds?: string[] }) {
    this.validateReferences(record, domainId => Boolean(this.get('domains', domainId)), cid => this.get<Category>('categories', cid), tid => this.get<Tag>('tags', tid));
  }
  private validateReferences(record: { categoryIds: string[]; tagIds: string[]; domainIds?: string[] }, hasDomain: (id: string) => boolean, getCategory: (id: string) => Category | undefined, getTag: (id: string) => Tag | undefined) {
    const domains = new Set<string>(record.domainIds || []);
    for (const domainId of domains) if (!hasDomain(domainId)) fail(400, 'INVALID_REFERENCE', `资料领域不存在：${domainId}`);
    for (const cid of record.categoryIds) { const category = getCategory(cid); if (!category) fail(400, 'INVALID_REFERENCE', `分类不存在：${cid}`); if (record.domainIds && !record.domainIds.includes(category!.domainId)) fail(400, 'DOCUMENT_DOMAIN_MISMATCH', '资料分类必须属于所选领域'); domains.add(category!.domainId); }
    for (const tid of record.tagIds) {
      const tag = getTag(tid); if (!tag) fail(400, 'INVALID_REFERENCE', `标签不存在：${tid}`);
      if (tag!.domainId && !domains.has(tag!.domainId)) fail(400, 'TAG_DOMAIN_MISMATCH', `标签 ${tag!.name} 仅适用于其所属领域，请先选择该领域的分类`);
    }
  }
  /** Taxonomy validation runs on every startup/import. Only reference arrays,
   * not stems, book bodies or editor drafts, cross the database boundary. */
  private *taxonomyReferenceMetadata(includeDrafts = false) {
    const { query, expressions } = this.database;
    for (const table of ['questions', 'documents', ...(includeDrafts ? ['document_drafts'] as const : [])] as const) {
      const field = (key: string) => table === 'document_drafts' ? expressions.nestedField<string>('data', ['state', key]) : expressions.field<string>('data', key);
      const rows = this.database.all(query.selectFrom(table).select([field('categoryIds').as('categoryIds'), field('tagIds').as('tagIds'), field('domainIds').as('domainIds')]));
      for (const row of rows) yield { categoryIds: JSON.parse(row.categoryIds), tagIds: JSON.parse(row.tagIds), ...(row.domainIds === null ? {} : { domainIds: JSON.parse(row.domainIds) }) } as { categoryIds: string[]; tagIds: string[]; domainIds?: string[] };
    }
  }
  validateTaxonomyReferences() {
    const domainIds = new Set(this.all<Domain>('domains').map(domain => domain.id));
    const categories = new Map(this.all<Category>('categories').map(category => [category.id, category]));
    const tags = new Map(this.all<Tag>('tags').map(tag => [tag.id, tag]));
    const hasDomain = (id: string) => domainIds.has(id), getCategory = (id: string) => categories.get(id), getTag = (id: string) => tags.get(id);
    for (const tag of tags.values()) this.validateTagReference(tag, hasDomain);
    for (const record of this.taxonomyReferenceMetadata(true)) this.validateReferences(record, hasDomain, getCategory, getTag);
  }
  validateCategory(category: Category) {
    if (!this.get('domains', category.domainId)) fail(400, 'INVALID_REFERENCE', '领域不存在');
    const daily = this.get<any>('settings', 'system')?.dailyPush;
    if (daily?.enabled && daily.categoryIds?.includes(category.id) && daily.domainId !== category.domainId) fail(409, 'DAILY_PUSH_CATEGORY_IN_USE', '每日推题正在使用此分类，请先调整推题范围');
    let current = category.parentId;
    const seen = new Set([category.id]);
    while (current) {
      if (seen.has(current)) fail(400, 'CATEGORY_CYCLE', '分类不能形成环');
      seen.add(current);
      const parent = this.get<Category>('categories', current) ?? fail(400, 'INVALID_REFERENCE', '父分类不存在');
      if (parent.domainId !== category.domainId) fail(400, 'CROSS_DOMAIN_PARENT', '父子分类必须在同一领域');
      current = parent.parentId;
    }
    if (this.all<Category>('categories').some(c => c.parentId === category.id && c.domainId !== category.domainId)) fail(409, 'CROSS_DOMAIN_CHILD', '分类仍有属于其他领域的子分类，不能直接修改领域');
  }
  deleteTaxonomy(table: 'domains' | 'categories' | 'tags', id: string) {
    this.require(table, id);
    const daily = this.get<any>('settings', 'system')?.dailyPush;
    if (daily?.enabled && (table === 'domains' ? daily.domainId === id : table === 'categories' && daily.categoryIds?.includes(id))) fail(409, 'DAILY_PUSH_SCOPE_IN_USE', '每日推题正在使用此范围，请先关闭或调整推题配置');
    const categories = this.all<Category>('categories');
    if (table === 'domains' && categories.some(c => c.domainId === id)) fail(409, 'IN_USE', '领域仍被分类引用');
    if (table === 'domains' && this.all<Tag>('tags').some(tag => tag.domainId === id)) fail(409, 'IN_USE', '领域仍被标签引用');
    if (table === 'domains' && this.all<DocumentRecord>('documents').some(document => document.domainIds?.includes(id))) fail(409, 'IN_USE', '领域仍被资料引用，包括已归档资料');
    if (this.all<DocumentDraft>('document_drafts').some(draft => table === 'domains' ? draft.state.domainIds?.includes(id) : draft.state[table === 'tags' ? 'tagIds' : 'categoryIds'].includes(id))) fail(409, 'DOCUMENT_DRAFT_IN_USE', '资料草稿仍引用此项，请先修改或删除相关草稿');
    if (table === 'categories' && categories.some(c => c.parentId === id)) fail(409, 'IN_USE', '分类仍有子分类');
    if (table !== 'domains') {
      const key = table === 'tags' ? 'tagIds' : 'categoryIds';
      if ([...this.all<Question>('questions'), ...this.all<DocumentRecord>('documents')].some(q => q[key].includes(id))) fail(409, 'IN_USE', '仍有题目或资料引用此项，包括已归档题目');
      if (this.all<Paper>('papers').some(p => table === 'tags' ? p.filters?.tagIds?.includes(id) : p.filters?.categoryId === id)) fail(409, 'IN_USE', '试卷筛选条件仍引用此项');
    } else if (this.all<Paper>('papers').some(p => p.filters?.domainId === id || p.domainId === id)) fail(409, 'IN_USE', '试卷组织或筛选条件仍引用此领域');
    this.remove(table, id);
  }
  categoryDescendants(id: string): Set<string> {
    this.require('categories', id);
    const result = new Set([id]); const categories = this.all<Category>('categories');
    let changed = true;
    while (changed) { changed = false; for (const c of categories) if (c.parentId && result.has(c.parentId) && !result.has(c.id)) { result.add(c.id); changed = true; } }
    return result;
  }
  study(id: string, partId?: string): StudyState { return (partId === undefined ? this.get<StudyState>('study', id) : this.get<StudyState>('study_parts', studyPartKey(id, partId))) ?? emptyStudy(id, partId); }
  putStudy(state: StudyState) { this.put(state.partId === undefined ? 'study' : 'study_parts', state.partId === undefined ? state.questionId : studyPartKey(state.questionId, state.partId), state); }
  question(id: string): Question { const q = this.require<Question>('questions', id); return enrichQuestionsWithFeedback(this, [{ ...q, study: this.study(id), ...(q.type === 'group' ? { partStudies: (q.parts || []).map(part => this.study(id, part.id)) } : {}) }])[0]!; }
  private questionSelection(query:Record<string,any>):QuestionSelection {
    const paperQuestions=query.paperId?this.require<Paper>('papers',query.paperId).questionIds:undefined;
    const categories=query.categoryId?[...this.categoryDescendants(query.categoryId)]:undefined;
    if (query.domainId) this.require('domains', query.domainId);
    const domainCategories=query.domainId?this.all<Category>('categories').filter(c=>c.domainId===query.domainId).map(c=>c.id):undefined;
    const tags: string[] = Array.isArray(query.tagIds) ? query.tagIds : String(query.tagIds || '').split(',').filter(Boolean);
    for (const t of tags) this.require('tags', t);
    return {paperQuestions,categories,domainCategories,tags};
  }
  questions(query:Record<string,any>={}):Question[]{return this.questionQueries.all(query,this.questionSelection(query));}
  questionPage(query:Record<string,any>={}):QuestionPage{const page=this.questionQueries.page(query,this.questionSelection(query));return {...page,items:enrichQuestionsWithFeedback(this,page.items)};}
  questionCount(query:Record<string,any>={}):number{return this.questionQueries.count(query,this.questionSelection(query));}
  questionMetadata(query:Record<string,any>={}){return this.questionQueries.metadata(query,this.questionSelection(query));}
  questionMetadataByIds(ids:string[]){return this.questionQueries.metadataByIds(ids);}
}
