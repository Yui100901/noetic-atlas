"""Freeze source-catalog set definitions into the current paper format."""


def materialize_content_sets(pack):
    if pack.get('questionBanks'):
        raise ValueError('Retired questionBanks are not supported')
    questions = {question['id']: question for question in pack['questions']}
    stamp = pack.get('generatedAt', '2026-11-10T00:00:00.000Z')
    papers = []
    for definition in pack.get('questionSets', []):
        ids = definition['questionIds']
        if len(set(ids)) != len(ids):
            raise ValueError('Duplicate set membership')
        snapshot = [questions[identity] for identity in ids]
        papers.append({
            'id': definition['id'], 'title': definition['name'],
            'description': definition.get('description', ''), 'mode': 'manual',
            'questionIds': ids[:], 'questionCount': len(ids), 'filters': None,
            'archived': True, 'version': 1, 'organization': 'other', 'domainId': None,
            'createdAt': definition.get('createdAt', stamp),
            'updatedAt': definition.get('updatedAt', stamp), 'snapshot': snapshot,
            'scoring': {
                'enabled': False, 'scheme': 'none', 'totalPoints': 0,
                'questionPoints': {identity: 0 for identity in ids},
                'objectivePercent': 0, 'actualObjectivePercent': 0,
                'objectivePoints': 0, 'subjectivePoints': 0,
                'pointsByType': {'short_answer': 3, 'true_false': 1, 'single_choice': 2,
                                 'multiple_choice': 4, 'fill_blank': 2, 'essay': 10, 'group': 6},
            },
        })
    pack['papers'] = pack.get('papers', []) + papers
    pack['questionBanks'] = []
    pack.pop('questionSets', None)
    return pack
