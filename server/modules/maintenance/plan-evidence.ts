import type { Store } from '../../core/store.js';
import type { LearningDay } from '../../../shared/models/learning-plan.js';
import type { ReviewDirection } from '../../../shared/models/adaptive-review.js';
import { recordPlanEvidence, type PlanEvidence } from '../learning-plans/progress.js';
import type { LearningResult } from '../practice/learning-results.js';

/** A task stores its first completion. Recheck surviving evidence after a
 * source reset so a later answer from another set can still complete it. */
export function restorePeerPlanEvidence(store: Store, ids: ReadonlySet<string>) {
  if (!ids.size) return;
  const db = store.database,
    x = db.expressions,
    questionIds = new Set<string>();
  for (const id of ids) {
    const [dayId, taskId] = JSON.parse(id) as [string, string];
    const task = store.get<LearningDay>('learning_days', dayId)?.tasks.find((t) => t.id === taskId);
    if (task) questionIds.add(task.questionId);
  }
  if (!questionIds.size) return;
  const evidence: PlanEvidence[] = [];
  const dayIds = new Map(
    db
      .all(
        db.query
          .selectFrom('attempts')
          .select('id')
          .select(x.field<string>('data', 'learningDayId').as('dayId')),
      )
      .map((row) => [row.id, row.dayId]),
  );
  const surviving = db.query
    .selectFrom('learning_results')
    .select('id')
    .select([
      x.field<string>('data', 'submittedAt').as('at'),
      x.field<string>('data', 'items').as('items'),
      x.field<ReviewDirection | null>('data', 'vocabularyDirection').as('direction'),
    ])
    .where((eb) =>
      eb.or([eb(x.field('data', 'reset'), 'is', null), eb(x.field('data', 'reset'), '=', 0)]),
    )
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom(x.arrayElements('learning_results.data', 'items').as('i'))
          .select('i.value')
          .where(
            x.valueInJson(
              eb.fn.coalesce(
                x.field<string>('i.value', 'sourceQuestionId'),
                x.field<string>('i.value', 'id'),
              ),
              [...questionIds],
            ),
          ),
      ),
    );
  for (const row of db.all(surviving)) {
    const items = JSON.parse(row.items) as LearningResult['items'];
    const dayId = dayIds.get(row.id);
    for (const item of items)
      if (item.answered && questionIds.has(item.sourceQuestionId || item.id))
        evidence.push({
          dayId,
          questionId: item.sourceQuestionId || item.id,
          partId: item.partId,
          direction: row.direction || 'standard',
          kind: 'answer',
          at: row.at,
          sourceId: row.id,
        });
  }
  for (const row of db.all(
    db.query
      .selectFrom('reviews')
      .select('data')
      .where(x.valueInJson(x.field('data', 'questionId'), [...questionIds])),
  )) {
    const review = JSON.parse(row.data);
    const event = review.schedulerEventId
      ? store.get<{ direction: ReviewDirection }>('review_events', review.schedulerEventId)
      : undefined;
    evidence.push({
      questionId: review.questionId,
      partId: review.partId,
      direction: event?.direction || 'standard',
      kind: 'review',
      at: review.reviewedAt,
      sourceId: review.schedulerEventId || review.id,
    });
  }
  evidence.sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sourceId.localeCompare(b.sourceId),
  );
  for (let offset = 0; offset < evidence.length; offset += 1000)
    recordPlanEvidence(store, evidence.slice(offset, offset + 1000), ids);
}
