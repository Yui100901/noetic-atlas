import type { Question, StudyState } from '../../../shared/models/types.js';
import { emptyStudy } from '../../../shared/questions/study-state.js';
import type { Store } from '../../core/store.js';
import { learningQuestionKey } from '../practice/learning-state.js';

export interface StudyLeaf { id: string; sourceId: string; partId?: string | null; type?: Question['type'] }
/** Load only requested sources; deleted/replaced parts cannot acquire another
 * part's state. Favorites deliberately belong to the whole source question. */
export function loadLeafStudies(store: Store, leaves: StudyLeaf[], options: { includeNotes?: boolean } = {}): Map<string, StudyState> {
  const result = new Map<string, StudyState>();
  if (!leaves.length) return result;
  const db = store.database, expr = db.expressions, sourceIds = [...new Set(leaves.map(leaf => leaf.sourceId))];
  const sources = new Map(db.all(db.query.selectFrom('questions as q').leftJoin('study as s', 's.id', 'q.id').select(['q.id', expr.field<Question['type']>('q.data', 'type').as('type'), expr.questionLearningLeaves('q.data').as('leaves'), options.includeNotes ? 's.data as study' : expr.jsonWithout('s.data', ['notes']).as('study')]).where(expr.idInJson('q.id', sourceIds))).map(row => [row.id, { type: row.type, leaves: JSON.parse(row.leaves) as StudyLeaf[], study: row.study ? { notes: '', ...JSON.parse(row.study) } as StudyState : emptyStudy(row.id) }]));
  const parts = new Map(db.all(db.query.selectFrom('study_parts as s').innerJoin('questions as q', join => join.onRef('q.id', '=', expr.field<string>('s.data', 'questionId'))).select(options.includeNotes ? 's.data' : expr.jsonWithout('s.data', ['notes']).as('data')).where(expr.idInJson('q.id', sourceIds))).map(row => { const state = { notes: '', ...JSON.parse(row.data) } as StudyState; return [JSON.stringify([state.questionId, state.partId]), state]; }));
  for (const leaf of leaves) {
    const source = sources.get(leaf.sourceId); if (!source) continue;
    if (leaf.partId != null) {
      const part = source.leaves.find(part => part.partId === leaf.partId);
      if (source.type !== 'group' || !part || leaf.type !== undefined && part.type !== leaf.type) continue;
      const study = parts.get(JSON.stringify([leaf.sourceId, leaf.partId])) || emptyStudy(leaf.sourceId, leaf.partId);
      result.set(learningQuestionKey(leaf.sourceId, leaf.id), { ...study, favorite: source.study.favorite });
    } else if (source.type !== 'group' && (leaf.type === undefined || source.type === leaf.type)) result.set(learningQuestionKey(leaf.sourceId, leaf.id), source.study);
  }
  return result;
}

export function requireStudyPart(store: Store, questionId: string, partId?: string) {
  const question = store.require<Question>('questions', questionId);
  if (partId !== undefined && (question.type !== 'group' || !question.parts?.some(part => part.id === partId))) return false;
  return true;
}
