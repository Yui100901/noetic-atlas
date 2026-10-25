import { sql, type RawBuilder, type Expression, type SqlBool } from 'kysely';

/** SQLite/WASM-specific JSON, Unicode and row-order semantics live only here.
 * A new database adapter implements this expression contract for its dialect. */
export class SqliteExpressions {
  private path(key: string) {
    // Paths and refs come from code, never HTTP input. Reject accidental unsafe use.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid database field');
    return sql.lit(`$.${key}`);
  }
  field<T = any>(ref: string, key: string): RawBuilder<T> { return sql<T>`json_extract(${sql.ref(ref)},${this.path(key)})`; }
  missing(ref: string, key: string): RawBuilder<SqlBool> { return sql<SqlBool>`json_type(${sql.ref(ref)},${this.path(key)}) is null`; }
  arrayAny(ref: string, key: string, values: readonly string[]): RawBuilder<SqlBool> {
    return sql<SqlBool>`exists(select 1 from json_each(${sql.ref(ref)},${this.path(key)}) as selected where selected.value in (select value from json_each(${JSON.stringify(values)})))`;
  }
  arrayAll(ref: string, key: string, values: readonly string[]): RawBuilder<SqlBool> {
    return sql<SqlBool>`not exists(select 1 from json_each(${JSON.stringify(values)}) as requested where not exists(select 1 from json_each(${sql.ref(ref)},${this.path(key)}) as selected where selected.value=requested.value))`;
  }
  arrayLength(ref:string,key:string):RawBuilder<number> { return sql<number>`coalesce(json_array_length(${sql.ref(ref)},${this.path(key)}),0)`; }
  /** A bounded attempt's judging metadata, excluding question bodies, material,
   * notes and subjective answer text. Dynamic JSON keys are quoted as data. */
  attemptLearningItems(ref:string):RawBuilder<string> {
    const data=sql.ref(ref),qid=sql`json_extract(item.value,'$.id')`;
    const answerPath=sql`'$.answers.' || json_quote(${qid})`;
    return sql<string>`(select coalesce(json_group_array(json_object(
      'id',${qid},'type',json_extract(item.value,'$.type'),
      'sourceQuestionId',json_extract(item.value,'$.sourceQuestionId'),
      'partId',json_extract(item.value,'$.partId'),
      'correctAnswers',json_extract(item.value,'$.correctAnswers'),'blanks',json_extract(item.value,'$.blanks'),
      'answerValue',case when json_extract(item.value,'$.type') in ('short_answer','essay') then null else json_extract(${data},${answerPath} || '.value') end,
      'selfScore',json_extract(${data},${answerPath} || '.selfScore'),
      'verdict',json_extract(${data},${answerPath} || '.verdict'),
      'scoringEnabled',coalesce(json_extract(${data},'$.scoring.enabled'),1),
      'maximumPoints',json_extract(${data},'$.scoring.questionPoints.' || json_quote(${qid}))
    )),'[]') from json_each(${data},'$.questions') as item)`;
  }
  /** Draft/task progress never returns a student's answer or a reference
   * answer. Compute presence inside the driver with ECMAScript whitespace. */
  private attemptAnswered(ref:string):RawBuilder<SqlBool> {
    const data = sql.ref(ref), qid = sql`json_extract(item.value,'$.id')`;
    const answerPath = sql`'$.answers.' || json_quote(${qid})`;
    const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    return sql<SqlBool>`case when json_type(${data},${answerPath} || '.value')='array' then exists(select 1 from json_each(${data},${answerPath} || '.value') as response where length(trim(cast(response.value as text),${whitespace}))>0) when json_type(${data},${answerPath} || '.value')='text' then length(trim(json_extract(${data},${answerPath} || '.value'),${whitespace}))>0 else 0 end`;
  }
  attemptProgressItems(ref: string): RawBuilder<string> {
    const data = sql.ref(ref), qid = sql`json_extract(item.value,'$.id')`;
    const answerPath = sql`'$.answers.' || json_quote(${qid})`;
    const answered=this.attemptAnswered(ref);
    return sql<string>`(select coalesce(json_group_array(json_object(
      'id',${qid},'sourceQuestionId',coalesce(json_extract(item.value,'$.sourceQuestionId'),${qid}),
      'partId',json_extract(item.value,'$.partId'),'type',json_extract(item.value,'$.type'),
      'answered',${answered},'selfScore',json_extract(${data},${answerPath} || '.selfScore'),
      'verdict',json_extract(${data},${answerPath} || '.verdict'),
      'points',json_extract(${data},'$.scoring.questionPoints.' || json_quote(${qid}))
    )),'[]') from json_each(${data},'$.questions') as item)`;
  }
  /** Analytics metadata only: presence, immutable classification and grades.
   * Reuse the exact progress presence expression without exposing answer text. */
  attemptAnalyticsItems(ref: string): RawBuilder<string> {
    const data=sql.ref(ref),qid=sql`json_extract(item.value,'$.id')`,answerPath=sql`'$.answers.' || json_quote(${qid})`;
    return sql<string>`(select coalesce(json_group_array(json_object(
      'id',json_extract(item.value,'$.id'),'sourceQuestionId',json_extract(item.value,'$.sourceQuestionId'),
      'partId',json_extract(item.value,'$.partId'),'type',json_extract(item.value,'$.type'),
      'categoryIds',json_extract(item.value,'$.categoryIds'),'tagIds',json_extract(item.value,'$.tagIds'),
      'difficulty',json_extract(item.value,'$.difficulty'),
      'answered',${this.attemptAnswered(ref)},'selfScore',json_extract(${data},${answerPath} || '.selfScore'),
      'verdict',json_extract(${data},${answerPath} || '.verdict'),'points',json_extract(${data},'$.scoring.questionPoints.' || json_quote(${qid}))
    )),'[]') from json_each(${data},'$.questions') as item)`;
  }
  /** Read-only fallback for old daily records, independent of dirty caches. */
  paperProgressRoots(ref: string): RawBuilder<string> {
    return sql<string>`(select coalesce(json_group_array(json_object('id',json_extract(member.value,'$.id'),'type',json_extract(member.value,'$.type'),'parts',case when json_extract(member.value,'$.type')='group' then (select coalesce(json_group_array(json_object('id',json_extract(part.value,'$.id'),'type',json_extract(part.value,'$.type'),'weight',coalesce(json_extract(part.value,'$.weight'),1))),'[]') from json_each(member.value,'$.parts') as part) else null end)),'[]') from json_each(${sql.ref(ref)},'$.snapshot') as member)`;
  }
  /** Identity metadata only; summary reads never materialize question bodies. */
  questionLearningLeaves(ref:string):RawBuilder<string> {
    const data=sql.ref(ref),root=sql`json_extract(${data},'$.id')`;
    return sql<string>`case when json_extract(${data},'$.type')='group' then
      (select coalesce(json_group_array(json_object('id',${root} || '::' || json_extract(part.value,'$.id'),'sourceId',${root},'partId',json_extract(part.value,'$.id'),'type',json_extract(part.value,'$.type'))),'[]') from json_each(${data},'$.parts') as part)
      else json_array(json_object('id',${root},'sourceId',${root},'type',json_extract(${data},'$.type'))) end`;
  }
  paperLearningLeaves(ref:string):RawBuilder<string> {
    const data=sql.ref(ref);
    return sql<string>`(select coalesce(json_group_array(json_object('id',leaf_id,'sourceId',source_id,'partId',part_id)),'[]') from (
      select json_extract(member.value,'$.id') as leaf_id,coalesce(json_extract(member.value,'$.sourceQuestionId'),json_extract(member.value,'$.id')) as source_id,json_extract(member.value,'$.partId') as part_id
      from json_each(${data},'$.snapshot') as member where json_extract(member.value,'$.type')!='group'
      union all
      select json_extract(member.value,'$.id') || '::' || json_extract(part.value,'$.id') as leaf_id,json_extract(member.value,'$.id') as source_id,json_extract(part.value,'$.id') as part_id
      from json_each(${data},'$.snapshot') as member join json_each(member.value,'$.parts') as part
      where json_extract(member.value,'$.type')='group'
    ))`;
  }
  /** Page-local frozen content, without unrelated questions or user answers. */
  selectedLearningQuestions(ref: string, identities: readonly { sourceId: string; id: string }[]): RawBuilder<string> {
    const wanted = JSON.stringify(identities.map(item => [item.sourceId, item.id]));
    return sql<string>`(select coalesce(json_group_array(json(item.value)),'[]') from json_each(${sql.ref(ref)},'$.questions') as item
      where exists(select 1 from json_each(${wanted}) as selected where json_extract(selected.value,'$[0]')=coalesce(json_extract(item.value,'$.sourceQuestionId'),json_extract(item.value,'$.id')) and json_extract(selected.value,'$[1]')=json_extract(item.value,'$.id')))`;
  }
  learningQuestionItems(ref:string,questionId:string,partId?:string):RawBuilder<string> {
    return sql<string>`(select coalesce(json_group_array(json(item.value)),'[]') from json_each(${sql.ref(ref)},'$.items') as item where coalesce(json_extract(item.value,'$.sourceQuestionId'),json_extract(item.value,'$.id'))=${questionId} ${partId===undefined?sql``:sql`and json_extract(item.value,'$.partId')=${partId}`})`;
  }
  selectedAttemptAnswers(ref:string,ids:readonly string[]):RawBuilder<string> {
    return sql<string>`(select coalesce(json_group_object(item.key,json(item.value)),'{}') from json_each(${sql.ref(ref)},'$.answers') as item where item.key in (select value from json_each(${JSON.stringify(ids)})))`;
  }
  arrayRecordsByIds(ref: string, key: string, ids: readonly string[]): RawBuilder<string> {
    return sql<string>`(select coalesce(json_group_array(json(item.value)),'[]') from json_each(${sql.ref(ref)},${this.path(key)}) as item where json_extract(item.value,'$.id') in (select value from json_each(${JSON.stringify(ids)})))`;
  }
  idInJson(ref: string, values: readonly string[]): RawBuilder<SqlBool> { return sql<SqlBool>`${sql.ref(ref)} in (select value from json_each(${JSON.stringify(values)}))`; }
  valueInJson(value:Expression<any>,values:readonly string[]):RawBuilder<SqlBool> {return sql<SqlBool>`${value} in (select value from json_each(${JSON.stringify(values)}))`;}
  unicodeContains(value: Expression<any>, needle: string): RawBuilder<SqlBool> { return sql<SqlBool>`atlas_unicode_contains(${value},${needle})=1`; }
  containsLiteral(value: Expression<any>, needle: string): RawBuilder<SqlBool> { return sql<SqlBool>`instr(${value},${needle})>0`; }
  startsWithLiteral(value: Expression<any>, needle: string): RawBuilder<SqlBool> { return sql<SqlBool>`instr(${value},${needle})=1`; }
  /** Bound snippets are selected only for the requested result page. Normalized
   * text supplies an approximate location; display text keeps its original case. */
  searchExcerpt(content: Expression<any>, normalized: Expression<any>, needle: string): RawBuilder<string> {
    return sql<string>`substr(${content},max(1,instr(${normalized},${needle})-60),220)`;
  }
  jsonWithout(ref: string, keys: readonly string[]): RawBuilder<string> { return sql<string>`json_remove(${sql.ref(ref)},${sql.join(keys.map(key=>this.path(key)))})`; }
  rowOrder(alias: string): RawBuilder<number> { return sql<number>`${sql.ref(`${alias}.rowid`)}`; }
  dateValue(value: Expression<any>): RawBuilder<number | null> { return sql<number | null>`julianday(${value})`; }
  concat(values: readonly Expression<any>[]): RawBuilder<string> { return sql<string>`${sql.join(values,sql` || ' ' || `)}`; }
  interpolated(ref: string,key: string): RawBuilder<string> { return sql<string>`case when json_type(${sql.ref(ref)},${this.path(key)}) is null then 'undefined' when json_type(${sql.ref(ref)},${this.path(key)})='null' then 'null' else ${this.field(ref,key)} end`; }
  objectArrayHas(ref:string,key:string,property:string,value:Expression<any>):RawBuilder<SqlBool> { return sql<SqlBool>`exists(select 1 from json_each(${sql.ref(ref)},${this.path(key)}) as member where json_extract(member.value,${this.path(property)})=${value})`; }
}
