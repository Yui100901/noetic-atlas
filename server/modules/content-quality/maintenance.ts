import type {Store} from '../../core/store.js';

/** Retire a removed automatic rule, rather than inventing a human resolution.
 * Historical scan executions retain their original counters. Only the derived
 * issue rows are removed; sources, feedback and other findings stay intact.
 * Call explicitly during upgrade/trusted restore, never from read-only GETs. */
export function retireMissingSourceIssues(store:Store):number {
  return store.transaction(()=>{
    const database=store.database;
    const condition=database.expressions.field<string>('data','rule');
    const count=Number(database.one(database.query.selectFrom('quality_issues')
      .select(eb=>eb.fn.countAll<number>().as('count'))
      .where(condition,'=','missing_source'))?.count||0);
    if(count)database.run(database.query.deleteFrom('quality_issues').where(condition,'=','missing_source'));
    return count;
  });
}

/** Empty standalone explanations are not evidence of inadequate answers.
 * Remove untouched automatic notices, preserving human decisions and linked
 * AI evidence for direct historical inspection without active queue counts. */
export function retireMissingExplanationIssues(store:Store):number {
  return store.transaction(()=>{
    const d=store.database,x=d.expressions;
    const linked=new Set(d.records<{qualityIssueId?:string}>('question_feedback').flatMap(row=>row.qualityIssueId?[row.qualityIssueId]:[]));
    const rows=d.all(d.query.selectFrom('quality_issues').select(['id','data']).where(x.field('data','rule'),'=','missing_explanation'));
    let removed=0;
    for(const row of rows){
      const issue=JSON.parse(row.data) as {status:string;note?:string;feedbackIds?:string[];origin?:string};
      if(issue.origin==='feedback'||!['open','stale'].includes(issue.status)||issue.note?.trim()||issue.feedbackIds?.length||linked.has(row.id))continue;
      d.deleteRecord('quality_issues',row.id);removed++;
    }
    return removed;
  });
}
