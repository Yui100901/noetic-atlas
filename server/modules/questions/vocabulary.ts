import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse} from '../../core/validation.js';
import type {Store} from '../../core/store.js';
import type {Category,Domain,Question} from '../../../shared/models/types.js';

export const vocabularyQuerySchema=z.object({word:z.string().trim().min(1).max(150)}).strict();
export const normalizeVocabularyHead=(value:string)=>value.normalize('NFKC').trim().toLowerCase();
export function registerVocabularyRoutes(app:FastifyInstance,store:Store){
  app.get('/api/vocabulary',async request=>{
    const {word:raw}=parse(vocabularyQuerySchema,request.query),word=raw.normalize('NFKC');
    const categories=new Map(store.all<Category>('categories').map(c=>[c.id,c]));
    const englishDomains=new Set(store.all<Domain>('domains').filter(d=>d.id==='english'||['英语','english'].includes(d.name.normalize('NFKC').trim().toLowerCase())).map(d=>d.id));
    if(!englishDomains.size)return {word,matches:[]};
    // Fetch exact lexical heads only: ordinary full-text search also matches
    // examples and licence text, which can hide the requested word in big banks.
    // SQLite lower() is ASCII-only by default. Read small head metadata, then
    // normalize both sides in JS so accented/full-width heads remain portable.
    const db=store.database,field=db.expressions.field.bind(db.expressions);
    // The covering type/title index supplies lexical heads without parsing the
    // full explanations of every vocabulary entry. Only exact matches load bodies.
    db.projections.ensure(['questions']);
    const rows=db.all(db.query.selectFrom('question_read_model').select(['id',field<string>('data','title').as('title')]).where('title_key','=',normalizeVocabularyHead(word)).where(field('data','type'),'=','short_answer'));
    const order={published:0,pending:1,draft:2,archived:3};
    const matches=rows.filter(q=>normalizeVocabularyHead(q.title)===normalizeVocabularyHead(word)).map(q=>store.require<Question>('questions',q.id)).filter(q=>q.categoryIds.some(id=>englishDomains.has(categories.get(id)?.domainId||''))).sort((a,b)=>order[a.status]-order[b.status]||a.id.localeCompare(b.id)).map(q=>({id:q.id,title:q.title,status:q.status}));
    return {word,matches};
  });
}
