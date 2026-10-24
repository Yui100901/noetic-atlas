import type { Question, QuestionPage, StudyState } from '../../../shared/models/types.js';
import { cleanLearningRecord } from '../../../shared/questions/learning-records.js';
import type { DatabaseConnection } from '../../database/connection.js';
import { QuestionOrder } from '../../database/question-order.js';
import { emptyStudy, studyPartKey } from '../../../shared/questions/study-state.js';

const enabled = (input:unknown) => input === true || input === 'true' || input === '1';
export interface QuestionSelection { categories?:string[]; domainCategories?:string[]; paperQuestions?:string[]; tags:string[] }
export type QuestionMetadata = Pick<Question,'id'|'title'|'type'|'status'|'collection'|'difficulty'|'depth'|'frequency'|'categoryIds'|'tagIds'>;

/** Question selection uses a typed query builder; JSON/search dialect details
 * and disposable ordering caches belong to the database adapter. */
export class QuestionQueries {
  private readonly order:QuestionOrder;
  constructor(private readonly database:DatabaseConnection) { this.order=new QuestionOrder(database); }

  private matches(query:Record<string,any>, selection:QuestionSelection) {
    const {expressions:expr}=this.database;
    const study=enabled(query.favorite)||enabled(query.wrong)||enabled(query.due);
    let result=this.database.query.selectFrom('question_read_model as q')
      .$if(study,builder=>builder.leftJoin('study as s','s.id','q.id'))
      .select('q.id');
    if(query.status!=='all')result=result.where(expr.field('q.data','status'),'=',query.status||'published');
    if(query.collection&&query.collection!=='all')result=result.where(expr.field('q.data','collection'),'=',query.collection);
    if(query.type)result=result.where(expr.field('q.data','type'),'=',query.type);
    if(query.types?.length)result=result.where(expr.field<string>('q.data','type'),'in',query.types);
    for(const field of ['difficulty','depth'])if(query[field])result=result.where(expr.field('q.data',field),'=',Number(query[field]));
    if(query.frequency!==undefined)result=result.where(expr.field('q.data','frequency'),'=',Number(query.frequency));
    for(const [input,field,operator]of [['difficultyMin','difficulty','>='],['difficultyMax','difficulty','<='],['frequencyMin','frequency','>=']] as const){
      if(input==='frequencyMin'?query[input]===undefined:!query[input])continue;
      // Old unmarked records have undefined fields: both JS range comparisons
      // were false. Explicit null, unlike undefined, is numerically zero.
      result=result.where(eb=>eb.or([expr.missing('q.data',field),eb(eb.fn.coalesce(expr.field<number>('q.data',field),eb.val(0)),operator,Number(query[input]))]));
    }
    if(selection.paperQuestions)result=result.where(expr.idInJson('q.id',selection.paperQuestions));
    for(const categories of [selection.categories,selection.domainCategories])if(categories)result=result.where(expr.arrayAny('q.data','categoryIds',categories));
    if(selection.tags.length)result=result.where(query.tagMode==='any'?expr.arrayAny('q.data','tagIds',selection.tags):expr.arrayAll('q.data','tagIds',selection.tags));
    const search=String(query.search||'').toLowerCase().trim();
    if(search)result=result.where(eb=>expr.containsLiteral(eb.ref('q.search_text'),search));
    if(enabled(query.favorite))result=result.where(eb=>eb(eb.fn.coalesce(expr.field<number>('s.data','favorite'),eb.val(0)),'!=',0));
    for (const kind of ['wrong', 'due'] as const) if(enabled(query[kind])) result=result.where(eb=>{
      const condition=(alias:string)=>kind==='wrong'?eb(eb.fn.coalesce(expr.field<number>(`${alias}.data`,'wrongCount'),eb.val(0)),'!=',0):eb.and([
        eb(eb.fn.coalesce(expr.field<string>(`${alias}.data`,'nextReviewAt'),eb.val('')),'!=',''),
        eb.or([eb(expr.dateValue(expr.field(`${alias}.data`,'nextReviewAt')),'is',null),eb(expr.dateValue(expr.field(`${alias}.data`,'nextReviewAt')),'<=',expr.dateValue(eb.val(new Date().toISOString())))])
      ]);
      return eb.or([
        eb.and([eb(expr.field('q.data','type'),'!=','group'),condition('s')]),
        eb.and([eb(expr.field('q.data','type'),'=','group'),eb.exists(eb.selectFrom('study_parts as sp').select('sp.id').whereRef(expr.field<string>('sp.data','questionId'),'=','q.id').where(expr.objectArrayHas('q.data','parts','id',expr.field('sp.data','partId'))).where(condition('sp')))])
      ]);
    });
    return result;
  }
  private decode(row:{data:string;study:string|null}):Question {
    const question=cleanLearningRecord('questions',JSON.parse(row.data)) as Question;
    return {...question,study:row.study?JSON.parse(row.study):emptyStudy(question.id)} as Question;
  }
  private withParts(questions:Question[]):Question[] {
    const groups=questions.filter(question=>question.type==='group'); if(!groups.length)return questions;
    const db=this.database,expr=db.expressions;
    const states=new Map(db.all(db.query.selectFrom('study_parts as sp').innerJoin('questions as q',join=>join.onRef('q.id','=',expr.field<string>('sp.data','questionId'))).select('sp.data').where(expr.idInJson('q.id',groups.map(question=>question.id)))).map(row=>{const state=JSON.parse(row.data) as StudyState;return [studyPartKey(state.questionId,state.partId!),state];}));
    for(const group of groups)group.partStudies=(group.parts||[]).map(part=>states.get(studyPartKey(group.id,part.id))||emptyStudy(group.id,part.id));
    return questions;
  }
  metadata(query:Record<string,any>,selection:QuestionSelection):QuestionMetadata[] {
    this.database.projections.ensure(['questions']);
    return this.database.all(this.matches(query,selection).clearSelect().select('q.data')).map(row=>JSON.parse(row.data) as QuestionMetadata);
  }
  metadataByIds(ids:string[]):{items:Pick<Question,'id'|'title'|'type'|'status'>[];missingIds:string[]} {
    // ID membership is one bound JSON value, so large sets do not hit SQL
    // parameter limits or decode the original Markdown/answers/study records.
    const rows=this.metadata({status:'all'},{paperQuestions:ids,tags:[]});
    const records=new Map(rows.map(({id,title,type,status})=>[id,{id,title,type,status}]));
    const items:Pick<Question,'id'|'title'|'type'|'status'>[]=[],missingIds:string[]=[];
    for(const id of ids){const record=records.get(id);if(record)items.push(record);else missingIds.push(id);}
    return {items,missingIds};
  }
  count(query:Record<string,any>,selection:QuestionSelection):number {
    this.database.projections.ensure(['questions']);
    return Number(this.database.one(this.matches(query,selection).clearSelect().select(eb=>eb.fn.countAll<number>().as('total')))?.total||0);
  }
  all(query:Record<string,any>,selection:QuestionSelection):Question[] {
    this.database.projections.ensure(['questions']);
    this.order.ensure();
    const builder=this.database.query.with(cte=>cte('chosen').materialized(),()=>this.matches(query,selection)
      .innerJoin('atlas_question_order as ordering','ordering.id','q.id').select('ordering.ordinal').orderBy('ordering.ordinal'))
      .selectFrom('chosen').innerJoin('questions as q','q.id','chosen.id').leftJoin('study as s','s.id','chosen.id')
      .select(['q.data','s.data as study']).orderBy('chosen.ordinal');
    return this.withParts(this.database.all(builder).map(row=>this.decode(row)));
  }
  page(query:Record<string,any>,selection:QuestionSelection):QuestionPage {
    const page=Number(query.page)||1,pageSize=Number(query.pageSize)||30;
    this.database.projections.ensure(['questions']);
    this.order.ensure();
    // Materialize matching IDs once: expensive filters are shared by COUNT and
    // LIMIT. Large body/study records are loaded only for the requested page.
    const builder=this.database.query
      .with(cte=>cte('matches').materialized(),()=>this.matches(query,selection))
      .with(cte=>cte('chosen').materialized(),db=>db.selectFrom('matches')
        .innerJoin('atlas_question_order as ordering','ordering.id','matches.id')
        .select(['matches.id','ordering.ordinal']).orderBy('ordering.ordinal').limit(pageSize).offset((page-1)*pageSize))
      .selectFrom(db=>db.selectFrom('matches').select(eb=>eb.fn.countAll<number>().as('total')).as('counts'))
      .leftJoin('chosen',join=>join.onTrue()).leftJoin('questions as q','q.id','chosen.id').leftJoin('study as s','s.id','chosen.id')
      .select(['counts.total','q.data','s.data as study']).orderBy('chosen.ordinal');
    // The count row remains present even when the requested page is empty.
    const rows=this.database.all(builder);
    const items=rows.flatMap(row=>row.data===null?[]:[this.decode({data:row.data,study:row.study})]);
    return {items:this.withParts(items),total:Number(rows[0]?.total||0),page,pageSize};
  }
  explain(query:Record<string,any>,selection:QuestionSelection) {
    this.database.projections.ensure(['questions']);
    return this.database.explain(this.matches(query,selection).clearSelect().select(eb=>eb.fn.countAll<number>().as('total')));
  }
}
