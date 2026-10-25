import type { DatabaseConnection } from './connection.js';
import type { SearchType } from '../../shared/models/search.js';

export const searchProjectionSources = ['questions', 'papers', 'documents', 'study', 'study_parts', 'domains', 'categories', 'tags'] as const;
type Source = typeof searchProjectionSources[number];
export const normalizeSearch = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
/** Strip payloads and executable/formatting syntax before indexing. We never
 * interpret Markdown/HTML or inspect attachments to build search text. */
export function searchPlain(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC')
    .replace(/<(script|style|iframe|object|svg)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/data:[^\s"'<>)]*/gi, ' ')
    .replace(/!\[([^\]\n]{0,1000})\]\([^\n)]{0,8192}\)/g, '$1 ')
    .replace(/!?\[([^\]\n]{0,1000})\]\[[^\]\n]{0,1000}\]/g, '$1 ')
    .replace(/\[([^\]\n]{1,1000})\]\([^\n)]{0,8192}\)/g, '$1 ')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/(?:https?:\/\/|\/api\/assets\/)[^\s<>"')\]]+/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/(?:[A-Za-z0-9+/]{160,}={0,2})/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/`+/g, '').replace(/^#{1,6}\s+/gm, '').replace(/\s+/gu, ' ').trim();
}
interface Metadata {
  id: string; title: string; href: string; description: string; status?: string;
  questionId?: string; partId?: string; updatedAt?: string; categoryIds: string[]; domainIds: string[];
}
const strings = (input: unknown): string[] => Array.isArray(input) ? input.filter((value): value is string => typeof value === 'string') : [];
const key = (source: Source, id: string) => JSON.stringify([source, id]);

/** Independent disposable index. Its queue never consumes another projection's
 * dirtiness, and normal business records remain authoritative and unchanged. */
export class SearchProjections {
  constructor(private readonly db: DatabaseConnection) {}
  initialize(): boolean {
    const d = this.db, q = d.query;
    const complete = ['search_read_model', 'search_projection_pending'].every(table => d.hasTable(table));
    const version = d.one(q.selectFrom('metadata').select('value').where('key', '=', 'search_projection_version'))?.value;
    d.transaction(() => {
      d.run(q.schema.createTable('search_read_model').ifNotExists().addColumn('key', 'text', c => c.primaryKey())
        .addColumn('source_table', 'text', c => c.notNull()).addColumn('source_id', 'text', c => c.notNull()).addColumn('kind', 'text', c => c.notNull())
        .addColumn('entity_id', 'text', c => c.notNull()).addColumn('question_id', 'text').addColumn('data', 'text', c => c.notNull())
        .addColumn('id_key', 'text', c => c.notNull()).addColumn('title_key', 'text', c => c.notNull()).addColumn('content_key', 'text', c => c.notNull())
        .addColumn('search_text', 'text', c => c.notNull()).addColumn('content', 'text', c => c.notNull())
        .addColumn('status', 'text', c => c.notNull()).addColumn('archived', 'integer', c => c.notNull()).addColumn('updated_at', 'text', c => c.notNull()));
      d.run(q.schema.createTable('search_projection_pending').ifNotExists().addColumn('source_table', 'text', c => c.notNull()).addColumn('source_id', 'text', c => c.notNull()).addPrimaryKeyConstraint('search_projection_pending_pk', ['source_table', 'source_id']));
      d.run(q.schema.createIndex('search_source_idx').ifNotExists().on('search_read_model').columns(['source_table', 'source_id']));
      d.run(q.schema.createIndex('search_kind_state_idx').ifNotExists().on('search_read_model').columns(['archived', 'status', 'kind']));
      d.run(q.schema.createIndex('search_question_idx').ifNotExists().on('search_read_model').column('question_id'));
      d.run(q.schema.createIndex('search_title_idx').ifNotExists().on('search_read_model').column('title_key'));
      d.run(q.schema.createIndex('search_updated_idx').ifNotExists().on('search_read_model').column('updated_at'));
      for (const table of searchProjectionSources) {
        const mark = (row: 'old' | 'new') => `INSERT INTO search_projection_pending(source_table,source_id) SELECT '${table}',${row}.id WHERE NOT EXISTS(SELECT 1 FROM search_projection_pending WHERE source_table='${table}' AND source_id=${row}.id);`;
        d.maintenance.exec(`CREATE TRIGGER IF NOT EXISTS atlas_search_${table}_insert AFTER INSERT ON ${table} BEGIN ${mark('new')} END;
          CREATE TRIGGER IF NOT EXISTS atlas_search_${table}_update AFTER UPDATE ON ${table} BEGIN ${mark('old')} ${mark('new')} END;
          CREATE TRIGGER IF NOT EXISTS atlas_search_${table}_delete AFTER DELETE ON ${table} BEGIN ${mark('old')} END;`);
      }
      if (!complete || version !== '1') {
        d.run(q.deleteFrom('search_read_model')); d.run(q.deleteFrom('search_projection_pending'));
        for (const table of searchProjectionSources) d.run(q.insertInto('search_projection_pending').columns(['source_table', 'source_id']).expression(eb => eb.selectFrom(table).select([eb.val(table).as('source_table'), 'id as source_id']).where('id', 'is not', null)).onConflict(c => c.columns(['source_table', 'source_id']).doNothing()));
        d.run(q.insertInto('metadata').values({ key: 'search_projection_version', value: '1' }).onConflict(c => c.column('key').doUpdateSet({ value: '1' })));
      }
    });
    return !complete || version !== '1';
  }
  private put(source: Source, sourceId: string, kind: SearchType, metadata: Metadata, content: string, reference = '', archived = false) {
    const d = this.db, body = searchPlain(content), title = searchPlain(metadata.title) || metadata.id;
    const data = { ...metadata, title };
    const row = { key: key(source, sourceId), source_table: source, source_id: sourceId, kind, entity_id: metadata.id, question_id: metadata.questionId || null,
      data: JSON.stringify(data), id_key: normalizeSearch(metadata.id), title_key: normalizeSearch(title), content_key: normalizeSearch(body),
      search_text: normalizeSearch([metadata.id, title, body, searchPlain(reference)].join(' ')), content: body,
      status: metadata.status || 'published', archived: Number(archived), updated_at: metadata.updatedAt && Number.isFinite(Date.parse(metadata.updatedAt)) ? new Date(metadata.updatedAt).toISOString() : '' };
    d.run(d.query.insertInto('search_read_model').values(row).onConflict(c => c.column('key').doUpdateSet(row)));
  }
  private metadata(record: any, id = record.id): Metadata {
    return { id, title: record.title || record.name || id, href: '', description: '', categoryIds: strings(record.categoryIds), domainIds: strings(record.domainIds), ...(typeof record.updatedAt === 'string' ? { updatedAt: record.updatedAt } : {}) };
  }
  private question(record: any) {
    const metadata = { ...this.metadata(record), status: record.status || 'published', href: `#/questions/${encodeURIComponent(record.id)}`, description: record.type === 'group' ? '组合题 · 包含公共材料及小题' : '知识题目' };
    const parts = Array.isArray(record.parts) ? record.parts : [];
    const prompt = (item: any) => [item.stemMarkdown, ...(Array.isArray(item.options) ? item.options.map((option: any) => option.text) : []), ...(Array.isArray(item.blanks) ? item.blanks.map((blank: any) => blank.label) : [])];
    const references = (item: any) => [item.answerMarkdown, item.explanationMarkdown, ...(Array.isArray(item.blanks) ? item.blanks.flatMap((blank: any) => strings(blank.answers)) : [])];
    const content = [...prompt(record), ...parts.flatMap((part: any) => [part.title, ...prompt(part)])].filter(value => typeof value === 'string').join('\n');
    const reference = [...references(record), record.vocabulary?.headword, record.vocabulary?.meaningPrompt, ...parts.flatMap(references)].filter(value => typeof value === 'string').join('\n');
    this.put('questions', record.id, 'question', metadata, content, reference, record.status === 'archived');
  }
  private note(source: 'study' | 'study_parts', sourceId: string, record: any, question: any) {
    if (!question || !searchPlain(record.notes)) return;
    const part = record.partId === undefined ? undefined : (question.parts || []).find((entry: any) => entry.id === record.partId);
    if (record.partId !== undefined && !part) return;
    const metadata = { ...this.metadata(question), id: sourceId, title: part ? `${question.title} · ${part.title}` : question.title, questionId: question.id, ...(part ? { partId: part.id } : {}),
      href: `#/questions/${encodeURIComponent(question.id)}${part ? `?part=${encodeURIComponent(part.id)}` : ''}`, status: question.status || 'published', description: part ? '组合小题学习笔记' : '整题学习笔记' };
    // Legacy study records have no note-edit timestamp. The source question's
    // edit date cannot stand in for an unknown note timestamp.
    if (typeof record.updatedAt === 'string') metadata.updatedAt = record.updatedAt;
    else delete metadata.updatedAt;
    this.put(source, sourceId, 'note', metadata, record.notes, '', question.status === 'archived');
  }
  private ordinary(source: Exclude<Source, 'questions' | 'study' | 'study_parts'>, record: any) {
    const metadata = this.metadata(record), name = record.name || record.title || record.id;
    if (source === 'papers') {
      metadata.href = `#/papers/${encodeURIComponent(record.id)}`; metadata.description = '题集'; metadata.domainIds = record.domainId ? [record.domainId] : [];
      this.put(source, record.id, 'paper', metadata, record.description || '', '', !!record.archived);
    } else if (source === 'documents') {
      const pdf = record.format === 'pdf'; metadata.href = `#/documents/${encodeURIComponent(record.id)}`; metadata.description = pdf ? 'PDF · 仅检索元数据' : 'Markdown资料';
      const attributes = [record.description, record.kind, record.author, record.publisher, record.publishedYear, record.fileName].filter(value => typeof value === 'string').join('\n');
      this.put(source, record.id, 'document', metadata, [attributes, pdf ? '' : record.bodyMarkdown || ''].join('\n'), '', !!record._archived);
    } else {
      const kind = ({ domains: 'domain', categories: 'category', tags: 'tag' } as const)[source];
      metadata.title = name; metadata.description = ({ domains: '知识领域', categories: '知识分类', tags: '知识标签' } as const)[source];
      metadata.domainIds = source === 'domains' ? [record.id] : record.domainId ? [record.domainId] : [];
      metadata.href = '#/questions?' + (source === 'domains' ? 'domainId=' : source === 'categories' ? 'categoryId=' : 'tagIds=') + encodeURIComponent(record.id);
      this.put(source, record.id, kind, metadata, record.description || '');
    }
  }
  private refreshNotes(questionIds: string[], supplied?: Map<string, any>) {
    if (!questionIds.length) return;
    const d = this.db, x = d.expressions;
    const questions = supplied || new Map(d.all(d.query.selectFrom('questions').select(['id', 'data']).where(x.idInJson('id', questionIds))).map(row => [row.id, JSON.parse(row.data)]));
    d.run(d.query.deleteFrom('search_read_model').where('kind', '=', 'note').where(x.idInJson('question_id', questionIds)));
    for (const source of ['study', 'study_parts'] as const) {
      const rows = d.all(d.query.selectFrom(source).select(['id', 'data']).where(source === 'study' ? x.idInJson('id', questionIds) : x.valueInJson(x.field<string>('data', 'questionId'), questionIds)));
      for (const row of rows) { const state = JSON.parse(row.data); this.note(source, row.id, state, questions.get(state.questionId || row.id)); }
    }
  }
  ensure() {
    const d = this.db, q = d.query;
    if (!d.one(q.selectFrom('search_projection_pending').select('source_id').limit(1))) return;
    d.transaction(() => {
      for (const source of searchProjectionSources) while (true) {
        const pending = d.all(q.selectFrom('search_projection_pending').select('source_id').where('source_table', '=', source).limit(100));
        if (!pending.length) break;
        const ids = pending.map(row => row.source_id), records = new Map(d.all(q.selectFrom(source).select(['id', 'data']).where('id', 'in', ids)).map(row => [row.id, JSON.parse(row.data)]));
        d.run(q.deleteFrom('search_read_model').where('source_table', '=', source).where('source_id', 'in', ids));
        if (source === 'questions') { for (const record of records.values()) this.question(record); this.refreshNotes(ids, records); }
        else if (source === 'study' || source === 'study_parts') {
          const parentIds = [...new Set([...records.values()].map(record => record.questionId || record.id))] as string[];
          const questions = new Map(parentIds.length ? d.all(q.selectFrom('questions').select(['id', 'data']).where(d.expressions.idInJson('id', parentIds))).map(row => [row.id, JSON.parse(row.data)]) : []);
          for (const [id, record] of records) this.note(source, id, record, questions.get(record.questionId || id));
        } else for (const record of records.values()) this.ordinary(source, record);
        d.run(q.deleteFrom('search_projection_pending').where('source_table', '=', source).where('source_id', 'in', ids));
      }
    });
  }
}
