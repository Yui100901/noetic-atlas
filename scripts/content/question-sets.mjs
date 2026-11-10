/** Source catalogs describe named sets; emitted packs contain frozen papers.
 * This is authoring support, not a reader for retired collection formats. */
export function materializeContentSets(pack) {
  if (pack.questionBanks?.length) throw new Error('Retired questionBanks are not supported');
  const questions = new Map(pack.questions.map((question) => [question.id, question]));
  const stamp = pack.generatedAt || '2026-11-10T00:00:00.000Z';
  const papers = (pack.questionSets || []).map((definition) => {
    const ids = definition.questionIds;
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate set membership');
    const snapshot = ids.map((id) => {
      const question = questions.get(id);
      if (!question) throw new Error('Missing set question: ' + id);
      return question;
    });
    return {
      id: definition.id,
      title: definition.name,
      description: definition.description || '',
      mode: 'manual',
      questionIds: [...ids],
      questionCount: ids.length,
      filters: null,
      archived: true,
      version: 1,
      organization: 'other',
      domainId: null,
      createdAt: definition.createdAt || stamp,
      updatedAt: definition.updatedAt || stamp,
      snapshot,
      scoring: {
        enabled: false,
        scheme: 'none',
        totalPoints: 0,
        questionPoints: Object.fromEntries(ids.map((id) => [id, 0])),
        objectivePercent: 0,
        actualObjectivePercent: 0,
        objectivePoints: 0,
        subjectivePoints: 0,
        pointsByType: {
          short_answer: 3,
          true_false: 1,
          single_choice: 2,
          multiple_choice: 4,
          fill_blank: 2,
          essay: 10,
          group: 6,
        },
      },
    };
  });
  pack.papers = [...(pack.papers || []), ...papers];
  pack.questionBanks = [];
  delete pack.questionSets;
  return pack;
}
