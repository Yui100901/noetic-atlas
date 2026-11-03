import { createHash } from 'node:crypto';
import { inspectRubricFormat } from '../../scripts/content/rubric-format.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import {
  buildSubjectiveRubric,
  supplementQuestionRubrics,
} from '../../scripts/content/grading-rubrics.js';
import {
  applyRubricBackfill,
  planRubricBackfill,
  questionContentDigest,
  recordTableDigest,
} from '../../scripts/content/backfill-rubrics.js';

const q = (id: string, fields: Record<string, unknown> = {}) =>
  questionSchema.parse({
    id,
    title: id,
    type: 'short_answer',
    stemMarkdown: `解释${id}`,
    answerMarkdown: `${id}指本题的特定概念，并受条件甲限制。`,
    explanationMarkdown: '不能省略条件甲而推广到所有情况。',
    status: 'published',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...fields,
  }) as Question;

test('vocabulary rules contain the actual meaning and part of speech without copying examples, licences or unrelated learning notes', () => {
  const question = q('EN-V-run', {
    title: 'run',
    stemMarkdown: '说明run的含义、词性与使用方式。',
    answerMarkdown:
      '**词性**：verb\n\n**English definition**：move fast on foot\n\n**中文释义**：跑',
    explanationMarkdown:
      '### 使用方式／搭配\nrun + 状语\n\n### 例句\nEXAMPLE_CANARY\n\n### 来源和许可\nLICENCE_CANARY\n\n### 学习与审核说明\nLEARNING_CANARY',
    vocabulary: {
      language: 'en',
      headword: 'run',
      meaningPrompt: '快速用脚移动；跑',
      acceptedAnswers: ['run'],
      pronunciations: [
        {
          label: '英式',
          ipa: '/rʌn/',
          sourceLabel: 'test',
          sourceUrl: 'https://example.test',
          license: 'test',
          method: 'manual',
        },
      ],
    },
  });
  const result = buildSubjectiveRubric(question);
  assert.equal(result.profile, 'vocabulary');
  assert.match(result.gradingRequirements, /move fast on foot/);
  assert.match(result.gradingRequirements, /verb/);
  assert.doesNotMatch(result.gradingRequirements, /快速用脚移动|中文释义：跑/);
  assert.match(result.gradingRequirements, /不要求逐字复述或中英重复/);
  assert.doesNotMatch(result.gradingRequirements, /核心方向正确|非核心细节|若题集启用计分/);
  assert.doesNotMatch(result.gradingRequirements, /EXAMPLE_CANARY|LICENCE_CANARY|LEARNING_CANARY/);
  assert.notEqual(
    result.gradingRequirements,
    buildSubjectiveRubric(
      q('EN-V-read', {
        ...question,
        id: 'EN-V-read',
        title: 'read',
        answerMarkdown: '阅读，理解书写内容。',
        vocabulary: {
          ...question.vocabulary!,
          headword: 'read',
          meaningPrompt: '阅读；理解书写内容',
        },
      }),
    ).gradingRequirements,
  );
});

test('concept definitions retain distinguishing conditions, formulas and explicit misconceptions', () => {
  const result = buildSubjectiveRubric(
    q('函数', {
      concept: {
        term: '函数',
        meaningPrompt: '每个输入恰有一个输出的映射',
        acceptedAnswers: ['函数'],
      },
      answerMarkdown: '给定输入集合，每个输入恰好对应一个输出。',
      explanationMarkdown:
        '### 辨析与适用边界\n不同输入可以得到同一输出，函数不要求一一对应。\n\n### 相关链接\nSOURCE_CANARY',
    }),
  );
  assert.equal(result.profile, 'concept');
  assert.match(result.gradingRequirements, /每个输入恰好对应一个输出/);
  assert.match(result.gradingRequirements, /不要求一一对应/);
  assert.doesNotMatch(result.gradingRequirements, /SOURCE_CANARY/);
  const database = buildSubjectiveRubric(
    q('数据库', { answerMarkdown: '### 数据结构\n包含键与值的映射结构。' }),
  );
  assert.match(database.gradingRequirements, /包含键与值/);
});

test('chemical and drug rubrics ground their required and safety points only in the existing reference', () => {
  const chemical = buildSubjectiveRubric(
    q('水', {
      stemMarkdown: '请说明物质名称、水的性质、常见反应与用途。',
      answerMarkdown:
        '**性质**：极性分子。\n\n**反应**：2H2O ⇌ H3O+ + OH−。\n\n**用途**：冷却换热。',
      explanationMarkdown:
        '### 关键风险与禁混边界\n热水和蒸汽可烫伤。\n\n### 来源和时效\nSOURCE_CANARY',
    }),
    undefined,
    ['化学'],
  );
  assert.equal(chemical.profile, 'chemical');
  assert.match(chemical.gradingRequirements, /2H2O ⇌ H3O\+ \+ OH−/);
  assert.match(chemical.gradingRequirements, /蒸汽可烫伤/);
  assert.doesNotMatch(chemical.gradingRequirements, /SOURCE_CANARY/);
  const drug = buildSubjectiveRubric(
    q('药A', {
      stemMarkdown: '请介绍作用机制和禁忌。',
      answerMarkdown: '对症缓解疼痛，精确机制未完全阐明。',
      explanationMarkdown:
        '### 主要注意点\n重复摄入同一成分需警惕。\n\n### 相互作用\n同时使用药B需核对。',
    }),
    undefined,
    ['医学与药学'],
  );
  assert.equal(drug.profile, 'medical');
  assert.match(drug.gradingRequirements, /未完全阐明/);
  assert.match(drug.gradingRequirements, /同时使用药B/);
  assert.doesNotMatch(drug.gradingRequirements, /\d+\s*(?:mg|毫克|片)/);
});

test('idioms retain supported meanings and essay rubrics keep only the original explicit scale', () => {
  const idiom = buildSubjectiveRubric(
    q('ZH-I-1', {
      title: '成语：一不拗众',
      stemMarkdown: '请解释成语并说明典故。',
      answerMarkdown: '一个人难以违抗众人的意见。',
      explanationMarkdown: '### 典故与词源\n【缺失】来源未提供。',
    }),
  );
  assert.equal(idiom.profile, 'idiom');
  assert.match(idiom.gradingRequirements, /一个人难以违抗/);
  assert.doesNotMatch(idiom.gradingRequirements, /来源未提供|不要求编造|成语作答标准/);
  const essay = buildSubjectiveRubric(
    q('essay', {
      type: 'essay',
      answerMarkdown: '1. 使用稳定草稿ID。\n2. 写入和淘汰在事务内完成。',
      explanationMarkdown: '**评分量规**：正确性40%；验证30%；取舍20%；表达10%。',
    }),
  );
  assert.equal(essay.profile, 'essay');
  assert.match(essay.gradingRequirements, /写入和淘汰在事务内/);
  assert.doesNotMatch(
    essay.gradingRequirements,
    /不同但能证明满足题设约束|关键步骤之间的联系|论述作答标准/,
  );
  assert.match(essay.gradingRequirements, /正确性40%/);
});

test('combination enrichment touches only blank subjective parts and preserves authored rubrics, answer structure and publication status', () => {
  const original = q('group', {
    type: 'group',
    parts: [
      {
        id: 'one',
        title: '解释',
        type: 'essay',
        stemMarkdown: '解释过程',
        answerMarkdown: '先检查，再执行。',
      },
      {
        id: 'two',
        title: '判断',
        type: 'true_false',
        stemMarkdown: '先检查。',
        correctAnswers: ['true'],
      },
      {
        id: 'three',
        title: '自定',
        type: 'short_answer',
        stemMarkdown: '解释自定标准',
        answerMarkdown: '具体答案',
        gradingRequirements: '人工已确认，不替换。',
      },
    ],
  });
  const result = supplementQuestionRubrics(original);
  assert.equal(result.generated.length, 1);
  assert.equal(result.generated[0]!.partId, 'one');
  assert.equal(result.question.gradingRequirements, undefined);
  assert.equal(result.question.parts![1]!.gradingRequirements, undefined);
  assert.equal(result.question.parts![2]!.gradingRequirements, '人工已确认，不替换。');
  assert.equal(questionContentDigest(result.question), questionContentDigest(original));
  assert.equal(supplementQuestionRubrics(result.question).generated.length, 0);
  assert.throws(
    () => buildSubjectiveRubric(q('obj', { type: 'true_false', correctAnswers: ['true'] })),
    /Only subjective/,
  );
});

test('missing reference evidence is explicitly marked for manual validation rather than guessed from a title', () => {
  const result = buildSubjectiveRubric(
    q('empty', { title: '测试题目', answerMarkdown: '', explanationMarkdown: '' }),
  );
  assert.equal(result.noEvidence, true);
  assert.match(result.gradingRequirements, /参考依据不足/);
  assert.match(result.gradingRequirements, /须先由人工补齐答案/);
  assert.doesNotMatch(result.gradingRequirements, /必要核对点/);
});

function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('questions', 'first', {
    ...q('first', { status: 'pending' }),
    notesPrivateUnknown: 'preserve_unknown_field',
  });
  store.put('questions', 'second', q('second'));
  store.put(
    'questions',
    'objective',
    q('objective', { type: 'true_false', correctAnswers: ['true'] }),
  );
  store.put('study', 'first', {
    questionId: 'first',
    notes: 'PRIVATE_NOTES_CANARY',
    favorite: true,
    mastery: 2,
  });
  store.put('papers', 'frozen', {
    id: 'frozen',
    snapshot: [q('first')],
    gradingRequirements: '本集补充',
  });
  return store;
}

test('ORM backfill is transactional and idempotent without modifying source answers, status, notes or frozen sets', (t) => {
  const store = fixture(t),
    db = store.database;
  const beforeQuestion = store.require<Question>('questions', 'first');
  const protectedBefore = new Map(
    ['study', 'papers', 'ai_settings', 'settings'].map((table) => [
      table,
      recordTableDigest(db, table as 'study'),
    ]),
  );
  const plan = planRubricBackfill(db);
  assert.equal(plan.counts.generatedItems, 2);
  const result = applyRubricBackfill(db, plan);
  assert.equal(result.totalPopulatedRubrics, 2);
  assert.equal(result.remainingMissingRubrics, 0);
  const after = store.require<Question>('questions', 'first');
  assert.equal(after.status, 'pending');
  assert.notEqual(after.updatedAt, beforeQuestion.updatedAt);
  assert.equal(questionContentDigest(after), questionContentDigest(beforeQuestion));
  assert.equal((after as any).notesPrivateUnknown, 'preserve_unknown_field');
  assert.doesNotMatch(JSON.stringify(plan.review), /PRIVATE_NOTES_CANARY/);
  for (const [table, expected] of protectedBefore)
    assert.equal(recordTableDigest(db, table as 'study'), expected);
  const repeated = planRubricBackfill(db);
  assert.equal(repeated.counts.generatedItems, 0);
  const fingerprint = recordTableDigest(db, 'questions');
  applyRubricBackfill(db, repeated);
  assert.equal(recordTableDigest(db, 'questions'), fingerprint);
});

test('a concurrent edit or newly added question invalidates the whole plan before writes', (t) => {
  const store = fixture(t),
    plan = planRubricBackfill(store.database);
  store.put('questions', 'first', {
    ...store.require<Question>('questions', 'first'),
    gradingRequirements: '用户刚写的要求。',
  });
  const current = recordTableDigest(store.database, 'questions');
  assert.throws(() => applyRubricBackfill(store.database, plan), /changed after planning/);
  assert.equal(recordTableDigest(store.database, 'questions'), current);
  const newer = planRubricBackfill(store.database);
  store.put('questions', 'added', q('added'));
  assert.throws(() => applyRubricBackfill(store.database, newer), /changed after planning/);
  assert.equal(store.require<Question>('questions', 'second').gradingRequirements, undefined);
});

test('a corrupt later entry rolls back previously written rows and their timestamps', (t) => {
  const store = fixture(t),
    plan = planRubricBackfill(store.database);
  const before = recordTableDigest(store.database, 'questions');
  assert.ok(plan.changes.length > 1);
  plan.changes[1]!.question.answerMarkdown = '不得更改的原题内容';
  assert.throws(() => applyRubricBackfill(store.database, plan), /unrelated question content/);
  assert.equal(recordTableDigest(store.database, 'questions'), before);
});

test('traditional medicine keeps concrete inline-labelled safety evidence and does not substitute modern pharmacology for traditional concepts', () => {
  const herb = q('MED26-HERB-example', {
    title: '人参',
    stemMarkdown: '人参：传统药性、药用部位、主要功效和用药风险有哪些？',
    answerMarkdown: '**传统分类**：补气药。\n\n**功效要点**：大补元气。',
    explanationMarkdown:
      '**药用部位**：根及根茎。\n\n**传统性味**：微苦、甘；平。\n\n**传统禁忌／注意**：不宜与藜芦同用。\n\n**现代药物合用**：与华法林等的临床研究结果并不一致。\n\n**传统配伍记录**：这里记录传统规则，不等于已由现代临床试验证实。',
  });
  const result = buildSubjectiveRubric(herb, undefined, ['医学与药学']);
  assert.equal(result.profile, 'traditional_medicine');
  assert.match(result.gradingRequirements, /根及根茎/);
  assert.match(result.gradingRequirements, /微苦、甘；平/);
  assert.match(result.gradingRequirements, /不宜与藜芦同用/);
  assert.match(result.gradingRequirements, /临床研究结果并不一致/);
  assert.match(result.gradingRequirements, /不等于已由现代临床试验证实/);
  assert.doesNotMatch(
    result.gradingRequirements,
    /按题干所问核对传统药性|不能直接改写为已经证实的现代疾病疗效/,
  );
  assert.doesNotMatch(result.gradingRequirements, /传统分类不能替代药理含义/);
});

test('rubric cleanup removes empty and duplicated labels and irrelevant formula boilerplate without deleting concrete risks', () => {
  const chemical = q('CHEM-ORG-SAFE', {
    title: '甲烷的性质与用途',
    stemMarkdown: '介绍甲烷的主要性质、反应与用途。',
    answerMarkdown: '甲烷是可燃气体。',
    explanationMarkdown:
      '### 用途及常见误区\n分子式给出元素计数，不一定唯一确定结构。\n\n### 风险\n风险：缺氧燃烧可能产生一氧化碳。\n\n### 注意事项\n注意事项：所核对条目未列明。',
  });
  const result = buildSubjectiveRubric(chemical, chemical, ['化学']);
  assert.equal(result.profile, 'chemical');
  assert.doesNotMatch(
    result.gradingRequirements,
    /分子式给出元素计数|注意事项：注意事项|所核对条目未列明|风险：风险：/,
  );
  assert.match(result.gradingRequirements, /缺氧燃烧可能产生一氧化碳/);
  const traditional = q('MED26-FORM-TEST', {
    title: '某传统方剂',
    stemMarkdown: '说明传统效能。',
    answerMarkdown: '传统效能：按题内功效理解。',
    explanationMarkdown: '',
  });
  assert.equal(
    buildSubjectiveRubric(traditional, traditional, ['医学与药学']).profile,
    'traditional_medicine',
  );
});

test('explicit manifest refresh updates only owned unchanged generation and preserves human rubric and source edits', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const owned = q('OWNED', { gradingRequirements: '旧生成标准' }),
    human = q('HUMAN', { gradingRequirements: '旧生成标准' }),
    source = q('SOURCE', { gradingRequirements: '旧生成标准' });
  const original = [owned, human, source];
  for (const item of original) store.put('questions', item.id, item);
  const manifest = {
    format: 'noetic-generated-rubrics' as const,
    version: 1 as const,
    generatorVersion: 'previous',
    createdAt: new Date().toISOString(),
    entries: original.map((item) => ({
      id: item.id,
      gradingRequirementsSha256: hash(item.gradingRequirements!),
      sourceContentHash: questionContentDigest(item),
    })),
  };
  store.put('questions', human.id, { ...human, gradingRequirements: '用户已手工修改' });
  store.put('questions', source.id, { ...source, answerMarkdown: '用户已修改答案' });
  const plan = planRubricBackfill(store.database, manifest);
  assert.deepEqual(
    plan.changes.map((item) => item.id),
    ['OWNED'],
  );
  assert.equal(plan.ownershipSkipped.length, 2);
  applyRubricBackfill(store.database, plan);
  assert.match(store.require<Question>('questions', owned.id).gradingRequirements!, /必要核对点/);
  assert.equal(
    store.require<Question>('questions', human.id).gradingRequirements,
    '用户已手工修改',
  );
  assert.equal(store.require<Question>('questions', source.id).answerMarkdown, '用户已修改答案');
  assert.equal(planRubricBackfill(store.database, manifest).changes.length, 0);
});

test('AST output retains code, nested labelled lists, tables and formulas without empty wrappers or phantom numbering', () => {
  const question = q('CS-format', {
    answerMarkdown:
      '1. 先检查结果。\n2. ```python\n   seen = {}\n   for i, x in enumerate(nums):\n       if target - x in seen:\n           return [seen[target - x], i]\n       seen[x] = i\n   ```\n3. - 第一项。\n   - 第二项。\n4. ...\n5. 参数：\n   - 输入集合非空。\n\n| 单位 | 含义 |\n| --- | --- |\n| N | 力 |\n\n$$\nF=ma\n$$',
    explanationMarkdown: '',
  });
  const result = buildSubjectiveRubric(question);
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
  assert.match(result.gradingRequirements, /    if target - x in seen:/);
  assert.match(result.gradingRequirements, /\| N \| 力 \|/);
  assert.match(result.gradingRequirements, /F=ma/);
  assert.doesNotMatch(result.gradingRequirements, /\d+\. ```|^- \d+\./m);
  assert.doesNotMatch(result.gradingRequirements, /^\s*[-*+]\s*\.\.\.$/m);
});

test('independent bold headings carry concrete water risks and identity conditions into the standard', () => {
  const result = buildSubjectiveRubric(
    q('CHEM-water', {
      stemMarkdown: '说明水的性质、实际产品区别与安全风险。',
      answerMarkdown: '常温为液体。',
      explanationMarkdown:
        '**物质身份与实际产品**\n\n蒸馏水、去离子水与饮用水有不同质量要求。\n\n**关键风险与禁混边界**\n\n热水和蒸汽可烫伤，不能向活泼金属随意加水。\n\n**理解与追问**\n\n解释上述反应时，应辨认反应类别。',
    }),
  );
  assert.match(result.gradingRequirements, /去离子水与饮用水/);
  assert.match(result.gradingRequirements, /不能向活泼金属随意加水/);
  assert.doesNotMatch(result.gradingRequirements, /理解与追问|解释上述反应/);
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
});

test('traditional indication evidence is selected when asked, while absent notes do not become invented grading rules', () => {
  const result = buildSubjectiveRubric(
    q('MED26-FORM-example', {
      title: '归脾汤',
      stemMarkdown: '归脾汤的主要功效、传统适用线索与注意事项是什么？',
      answerMarkdown: '**传统效能**：健脾宁心、益气补血。',
      explanationMarkdown:
        '**传统适应证表述**：心脾两虚、气血不足、心悸、不眠。\n\n**组成药材名称**：人参、黄耆。\n\n**注意事项**：所核对条目未列明。',
    }),
    undefined,
    ['医学与药学'],
  );
  assert.match(result.gradingRequirements, /心脾两虚、气血不足/);
  assert.doesNotMatch(result.gradingRequirements, /组成药材|所核对条目未列明|按题干所问/);
});

test('English meaning uses source English semantics rather than treating a questionable Chinese synonym string as equivalent', () => {
  const word = q('EN-V-abduct', {
    title: 'abduct',
    stemMarkdown: '回忆abduct的含义与词性。',
    answerMarkdown:
      '**词性**：verb\n\n**English definition**：take someone away against their will, usually to obtain ransom\n\n**中文释义**：绑架；诈骗',
    explanationMarkdown:
      '### 使用方式／搭配\n- WordNet框架8；义项 00000001-v\n\n### 同音联想（需注意词性）\nRELATED_CANARY',
    vocabulary: {
      language: 'en',
      headword: 'abduct',
      meaningPrompt: '违背本人意愿带走他人，通常为索取赎金',
      acceptedAnswers: ['abduct'],
      pronunciations: [
        {
          label: 'test',
          ipa: '/x/',
          sourceLabel: 'test',
          sourceUrl: 'https://example.test',
          license: 'test',
          method: 'manual',
        },
      ],
    },
  });
  const result = buildSubjectiveRubric(word);
  assert.match(result.gradingRequirements, /against their will/);
  assert.match(result.gradingRequirements, /ransom/);
  assert.match(result.gradingRequirements, /verb：take someone away/);
  assert.doesNotMatch(
    result.gradingRequirements,
    /诈骗|WordNet|00000001|RELATED_CANARY|主要义项|部分正确：/,
  );
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
});

test('Japanese forward evidence requires the asked reading and English sense but not a homophone target or unasked grammatical label', () => {
  const word = q('JA-V-ano', {
    title: 'あの',
    stemMarkdown: '写出あの的读音与主要含义。',
    answerMarkdown: '**读音**：あの ／ あのー\n\n**中文主要释义**：嗯；那个',
    explanationMarkdown:
      '**词性**：感叹词\n\n**英文释义（JMdict）**\n\n1. say; well; um; er\n\n**同音联想（不表示同义，需注意重音、语境与词性）**：[彼の](#/questions/other)',
    vocabulary: {
      language: 'ja',
      headword: 'あの',
      meaningPrompt: '开口前迟疑的填充用语',
      acceptedAnswers: ['あの'],
      pronunciations: [
        {
          label: 'test',
          kana: 'あの',
          romaji: 'ano',
          sourceLabel: 'test',
          sourceUrl: 'https://example.test',
          license: 'test',
          method: 'manual',
        },
      ],
    },
  });
  const result = buildSubjectiveRubric(word);
  assert.match(result.gradingRequirements, /say; well; um; er/);
  assert.match(result.gradingRequirements, /あの ／ あのー/);
  assert.doesNotMatch(result.gradingRequirements, /彼の|感叹词|同音/);
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
});

test('numeric answers and source punctuation are kept without blanket punctuation rewriting', () => {
  const result = buildSubjectiveRubric(
    q('year', { answerMarkdown: '1948', explanationMarkdown: '' }),
  );
  assert.equal(result.noEvidence, false);
  assert.match(result.gradingRequirements, /1948/);
  const precise = buildSubjectiveRubric(
    q('units', {
      answerMarkdown: '单位为 N·m；符号 F=ma，不把 N/m 改成 N·m。',
      explanationMarkdown: '',
    }),
  );
  assert.match(precise.gradingRequirements, /N·m；符号 F=ma，不把 N\/m 改成 N·m/);
});

test('actual WordNet answer layout recognises plain English fields and keeps each sense with its own POS without IDs', () => {
  const vocabulary = {
    language: 'en' as const,
    headword: 'abandon',
    meaningPrompt: '放弃；离弃；遗弃；抛弃',
    acceptedAnswers: ['abandon'],
    pronunciations: [
      {
        label: 'test',
        ipa: '/x/',
        sourceLabel: 'test',
        sourceUrl: 'https://example.test',
        license: 'test',
        method: 'manual' as const,
      },
    ],
  };
  const word = q('EN-V-000003', {
    title: 'abandon',
    stemMarkdown: '请回忆其英文含义、中文释义、主要词性及使用方式。',
    answerMarkdown:
      '**verb / 动词 · 02228031-v**\n\nEnglish: forsake, leave behind\n\n中文义项：放弃；离弃；遗弃\n\n---\n\n**verb / 动词 · 02227741-v**\n\nEnglish: give up with the intent of never claiming again\n\n中文义项：抛弃；放弃',
    explanationMarkdown:
      '### 使用方式／搭配\n- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02228031-v）',
    vocabulary,
  });
  const result = buildSubjectiveRubric(word);
  assert.match(result.gradingRequirements, /verb \/ 动词：forsake, leave behind/);
  assert.match(
    result.gradingRequirements,
    /verb \/ 动词：give up with the intent of never claiming again/,
  );
  assert.doesNotMatch(
    result.gradingRequirements,
    /02228031|02227741|WordNet|中文义项|某人|词性：verb/,
  );
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
  const abduct = {
    ...word,
    id: 'EN-V-000010',
    title: 'abduct',
    answerMarkdown:
      '**verb / 动词 · 01471043-v**\n\nEnglish: take away to an undisclosed location against their will and usually in order to extract a ransom\n\n中文义项：拐带；绑架；绑票；诈骗；诱拐',
    vocabulary: {
      ...vocabulary,
      headword: 'abduct',
      meaningPrompt: '拐带；绑架；绑票；诈骗；诱拐',
      acceptedAnswers: ['abduct'],
    },
  };
  const concrete = buildSubjectiveRubric(abduct);
  assert.match(concrete.gradingRequirements, /against their will/);
  assert.match(concrete.gradingRequirements, /extract a ransom/);
  assert.doesNotMatch(concrete.gradingRequirements, /诈骗|01471043|中文义项/);
  const different = {
    ...word,
    answerMarkdown:
      '**noun / 名词 · 00000001-n**\n\nEnglish: alpha meaning\n\n---\n\n**verb / 动词 · 00000002-v**\n\nEnglish: beta meaning',
  };
  const associated = buildSubjectiveRubric(different).gradingRequirements;
  assert.match(associated, /noun \/ 名词：alpha meaning/);
  assert.match(associated, /verb \/ 动词：beta meaning/);
  assert.doesNotMatch(associated, /noun \/ 名词：beta meaning/);
});

test('unfenced generic type names remain visible as literal code instead of hidden HTML nodes', () => {
  const result = buildSubjectiveRubric(
    q('JAVA-generics', {
      answerMarkdown:
        'List<Integer> 不是 List<Number> 的子类型，<Dog> 与 <Animal> 也不能直接替换。',
      explanationMarkdown: '',
    }),
  );
  assert.match(result.gradingRequirements, /List`<Integer>`/);
  assert.match(result.gradingRequirements, /List`<Number>`/);
  assert.match(result.gradingRequirements, /`<Dog>`/);
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
});

test('an idiom with only unasked pinyin and ellipsis is marked as missing meaning evidence instead of grading pronunciation', () => {
  const result = buildSubjectiveRubric(
    q('ZH-I-001827', {
      title: '成语：患难与共',
      stemMarkdown: '请解释成语「患难与共」的含义、使用语境，并尝试说出其典故或文献出处。',
      answerMarkdown: '**拼音：** huànnànyǔgòng\n\n1. ...',
      explanationMarkdown:
        '### 拼音\nhuànnànyǔgòng\n\n### 字形\n患難與共。\n\n### 寓意与释义\n1. ...\n\n### 典故与词源\n【缺失】来源未提供可提取的词源资料，待人工补全。\n\n### 使用提示\n结合上下文判断褒贬、对象与语体；本条未单独编写易错辨析。',
    }),
  );
  assert.equal(result.noEvidence, true);
  assert.match(result.gradingRequirements, /未提供可核对的成语释义/);
  assert.doesNotMatch(result.gradingRequirements, /huànnànyǔgòng|必要核对点|来源未提供可提取/);
  assert.deepEqual(inspectRubricFormat(result.gradingRequirements), []);
});

test('word-card default and explicit all-sense requirements state their coverage instead of leaving scope ambiguous', () => {
  const word = q('WORD-SCOPE', {
    stemMarkdown: '请说明词义和主要词性。',
    answerMarkdown: '**词性**：verb\n\nEnglish: move quickly on foot',
    vocabulary: {
      language: 'en',
      headword: 'run',
      meaningPrompt: '跑',
      acceptedAnswers: ['run'],
      pronunciations: [
        {
          label: 'test',
          ipa: '/rʌn/',
          sourceLabel: 'test',
          sourceUrl: 'https://example.test',
          license: 'test',
          method: 'manual',
        },
      ],
    },
  });
  const normal = buildSubjectiveRubric(word).gradingRequirements;
  assert.match(normal, /义项任选一项/);
  assert.match(normal, /所选义项对应的词性/);
  const exhaustive = buildSubjectiveRubric({
    ...word,
    stemMarkdown: '逐一说明所有义项。',
  }).gradingRequirements;
  assert.match(exhaustive, /下列全部义项/);
  assert.doesNotMatch(exhaustive, /任选一项/);
});
