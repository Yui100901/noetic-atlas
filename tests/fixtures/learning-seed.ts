import type { Question, SeedData } from '../../shared/models/types.js';

const stamp = '2026-10-20T00:00:00.000Z';

/** A few synthetic records for API tests, never a bundled learning catalog. */
export function fixtureQuestion(id: string, type: Question['type'], changes: Partial<Question> = {}): Question {
  return {
    id, title: `测试记录 ${id}`, type, stemMarkdown: `测试题干 ${id}`, answerMarkdown: `测试答案 ${id}`, explanationMarkdown: `测试解析 ${id}`,
    options: ['single_choice', 'multiple_choice'].includes(type) ? [{ key: 'A', text: '测试选项 A' }, { key: 'B', text: '测试选项 B' }, { key: 'C', text: '测试选项 C' }] : [],
    correctAnswers: type === 'true_false' ? ['true'] : type === 'single_choice' ? ['B'] : type === 'multiple_choice' ? ['A', 'C'] : [],
    difficulty: 1, depth: 1, frequency: 0, frequencyScope: '', frequencyBasis: '测试数据，无统计含义',
    collection: 'general', status: 'published', categoryIds: ['fixture-basic'], tagIds: ['fixture-topic', 'fixture-method'], sourceRefs: [], sourceDocument: null, sourceAnchor: null,
    createdAt: stamp, updatedAt: stamp, ...changes,
  };
}

export function learningSeed(options: { includeNonPublic?: boolean } = {}): SeedData {
  const questions = [
    fixtureQuestion('FIXTURE-CHOICE-1', 'single_choice'), fixtureQuestion('FIXTURE-CHOICE-2', 'single_choice'),
    fixtureQuestion('FIXTURE-BOOL', 'true_false'), fixtureQuestion('FIXTURE-MULTI', 'multiple_choice'),
    fixtureQuestion('FIXTURE-SHORT-1', 'short_answer'), fixtureQuestion('FIXTURE-SHORT-2', 'short_answer', { categoryIds: ['fixture-child'] }),
  ];
  if (options.includeNonPublic) questions.push(
    fixtureQuestion('FIXTURE-PERSONAL', 'short_answer', { collection: 'personal' }),
    fixtureQuestion('FIXTURE-PENDING', 'true_false', { status: 'pending' }),
  );
  return {
    schemaVersion: 1, generatedAt: stamp,
    domains: [{ id: 'fixture-computer', name: '测试领域', description: '', sortOrder: 0 }],
    categories: [
      { id: 'fixture-basic', domainId: 'fixture-computer', parentId: null, name: '测试基础', description: '', sortOrder: 0 },
      { id: 'fixture-child', domainId: 'fixture-computer', parentId: 'fixture-basic', name: '测试子类', description: '', sortOrder: 0 },
    ],
    tags: [
      { id: 'fixture-topic', name: '测试主题', color: '#123456', description: '', domainId: 'fixture-computer', kind: 'topic' },
      { id: 'fixture-method', name: '测试方式', color: '#654321', description: '', domainId: null, kind: 'method' },
    ],
    questions, questionBanks: [], documents: [], papers: [],
  };
}
