import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MATH_LIMITS,
  hasMath,
  literalMathMarkdown,
  mathExpressions,
  mathDelimiterErrors,
} from '../../shared/math/markdown.js';
import { inspectMathMarkdown, renderFormula } from '../../shared/math/engine.js';
import { insertFormulaMarkdown } from '../../web/shared/lib/markdown-authoring.js';
import {
  questionSchema,
  documentSchema,
  answerSchema,
  studySchema,
} from '../../server/core/validation.js';
import { inspectQuestionQuality } from '../../server/modules/content-quality/rules.js';
import {
  documentContentVersion,
  captureDocumentVersion,
  readDocumentSource,
} from '../../server/modules/library/sources.js';
import { Store } from '../../server/core/store.js';
import { buildPaper, createAttempt, submitAttempt } from '../../server/modules/practice/service.js';
import {
  attemptExportDocument,
  paperExportDocument,
} from '../../server/modules/transfer/exports.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { prepareAiQuestionMath, AI_MATH_INSTRUCTIONS } from '../../shared/ai/math.js';
import { finalizeImport } from '../../server/modules/ai/import.js';
import { exportShare, importShare } from '../../server/modules/sharing/routes.js';
import { aiImportInputSchema } from '../../server/modules/ai/schema.js';
import type { Question, DocumentRecord } from '../../shared/models/types.js';

const question = (id = 'MATH', patch: Partial<Question> = {}): Question => ({
  ...questionSchema.parse({
    id,
    title: '专业表达',
    type: 'short_answer',
    stemMarkdown: '说明关系',
    answerMarkdown: '参考结论',
  }),
  id,
  ...patch,
});
test('math AST preserves UTF-16 source and ignores ordinary code/URLs', () => {
  const source =
    '😀 原文 $x_i^2$。\n\n$$\n\\frac{a}{b}\n$$\n\n`$literal$` [来源](https://example.test/$item$)\n\n```js\nconst price = "$10";\n```';
  const tokens = mathExpressions(source);
  assert.equal(tokens.length, 2);
  assert.equal(source.slice(tokens[0]!.start, tokens[0]!.end), '$x_i^2$');
  assert.equal(tokens[0]!.source, 'x_i^2');
  assert.equal(tokens[1]!.display, true);
  assert.ok(tokens.every((x) => x.closed));
  assert.deepEqual(mathDelimiterErrors(source), []);
  assert.equal(hasMath('`$x$`\n\n```js\n$notMath$\n```'), false);
});
test('literal export escapes prose dollars without changing code, links or existing escapes', () => {
  const source =
    '售价 $10 与 $20，转义 \\$30；`$code$`。\n\n```sh\n$HOME\n```\n\n[链接](https://example.test/$id$)';
  assert.equal(
    literalMathMarkdown(source),
    '售价 \\$10 与 \\$20，转义 \\$30；`$code$`。\n\n```sh\n$HOME\n```\n\n[链接](https://example.test/$id$)',
  );
  assert.equal(literalMathMarkdown(literalMathMarkdown(source)), literalMathMarkdown(source));
});
test('scientific, chemical and matrix expressions share the safe renderer', () => {
  for (const source of [
    String.raw`\frac{1}{2}`,
    String.raw`x_i^2+\sqrt{a}`,
    String.raw`\sum_{i=1}^{n}i`,
    String.raw`\int_a^b f(x)\,\mathrm{d}x`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`9.8\,\mathrm{m/s^2}`,
    String.raw`\ce{2H2 + O2 -> 2H2O}`,
    String.raw`\ce{SO4^2-}`,
    String.raw`\ce{CO2 + H2O <=> H2CO3}`,
  ]) {
    const result = renderFormula(source, true);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.match(result.html, /class="katex/);
      assert.match(result.html, /application\/x-tex/);
    }
  }
});
test('unsupported commands, malformed input and expansion abuse produce actionable errors', () => {
  for (const source of [
    String.raw`\frac{1}{`,
    '\frac{1}{2}', // A JSON \f escape must not silently become literal rac.
    '',
    String.raw`\unknowncommand{x}`,
    String.raw`\href{javascript:alert(1)}{x}`,
    String.raw`\htmlClass{evil}{x}`,
    String.raw`\gdef\x{x}\x`,
    String.raw`\newcommand{\foo}{x}`,
    'x'.repeat(MATH_LIMITS.sourceCharacters + 1),
  ])
    assert.equal(renderFormula(source).ok, false, source.slice(0, 80));
  assert.equal(
    renderFormula(String.raw`\foo`).ok,
    false,
    'macros cannot leak from another formula',
  );
  assert.ok(inspectMathMarkdown('$$\nx+1').some((x) => x.message.includes('未闭合')));
  assert.ok(inspectMathMarkdown('求 $x+1').some((x) => x.message.includes('未闭合')));
});
test('formula insertion preserves selected content position and paragraph separation', () => {
  const inline = insertFormulaMarkdown('前😀原词后', 3, 5, 'x^2', false);
  assert.equal(inline.value, '前😀$x^2$后');
  assert.equal(inline.selectionStart, 8);
  const block = insertFormulaMarkdown('前后', 1, 1, String.raw`\ce{H2O}`, true);
  assert.equal(block.value, '前\n\n$$\n\\ce{H2O}\n$$\n\n后');
  assert.equal(block.selectionStart, block.value.length - 1);
});
test('format metadata is optional and shared schemas preserve it', () => {
  assert.equal(questionSchema.parse(question()).mathEnabled, undefined);
  assert.equal(questionSchema.parse(question('q', { mathEnabled: true })).mathEnabled, true);
  assert.equal(documentSchema.parse({ title: '公式', mathEnabled: true }).mathEnabled, true);
  assert.equal(answerSchema.parse({ value: '$x$', mathEnabled: true }).mathEnabled, true);
  assert.equal(studySchema.parse({ notes: '$x$', notesMathEnabled: true }).notesMathEnabled, true);
});
test('quality checks only enabled content and distinguishes syntax from correctness', () => {
  const raw = question('q', { stemMarkdown: '错误示例 $\\frac{a}{$' });
  assert.equal(inspectQuestionQuality(raw).filter((x) => x.rule === 'math_syntax').length, 0);
  const issues = inspectQuestionQuality({ ...raw, mathEnabled: true });
  assert.ok(issues.some((x) => x.rule === 'math_syntax' && x.message.includes('题干')));
  assert.equal(
    inspectQuestionQuality(question('valid', { mathEnabled: true, stemMarkdown: '$1=2$' })).filter(
      (x) => x.rule === 'math_syntax',
    ).length,
    0,
    'syntax validation must not claim mathematical correctness',
  );
});
test('legacy source hashes stay byte-compatible and math mode creates an immutable new version', () => {
  const store = new Store(':memory:');
  try {
    const document: DocumentRecord = {
      ...documentSchema.parse({
        title: '公式原文',
        bodyMarkdown: '😀\n\n$x+1$ 原文',
        mathEnabled: false,
      }),
      id: 'doc',
    };
    const legacy = createHash('sha256')
      .update(JSON.stringify(['markdown', document.bodyMarkdown]))
      .digest('hex');
    assert.equal(documentContentVersion(document), legacy);
    const original = captureDocumentVersion(store, document),
      next = { ...document, mathEnabled: true };
    assert.notEqual(documentContentVersion(next), legacy);
    store.put('documents', next.id, next);
    const current = captureDocumentVersion(store, next);
    assert.equal(readDocumentSource(store, document.id, original.versionId).mathEnabled, false);
    assert.equal(readDocumentSource(store, document.id, current.versionId).mathEnabled, true);
    assert.equal(current.bodyMarkdown, original.bodyMarkdown);
  } finally {
    store.db.close();
  }
});
test('paper snapshots and all export modes preserve math without reinterpreting currency', () => {
  const store = new Store(':memory:');
  try {
    const qs = [
      question('formula', {
        mathEnabled: true,
        stemMarkdown: '求 $x_i^2$。',
        answerMarkdown: '$$\n\\frac{1}{2}\n$$',
      }),
      question('currency', { stemMarkdown: '售价 $10，预算 $20。' }),
    ];
    for (const q of qs) store.put('questions', q.id, q);
    const paper = buildPaper(store, {
      title: '专业表达题集',
      description: '费用 $10',
      mode: 'manual',
      questionIds: qs.map((q) => q.id),
      scoring: { enabled: false },
    });
    store.put('questions', 'formula', { ...qs[0]!, mathEnabled: false, stemMarkdown: '后续编辑' });
    for (const mode of ['blank', 'answers'] as const) {
      const exported = paperExportDocument(paper, mode);
      assert.equal(exported.mathEnabled, true);
      assert.equal(exported.questions[0]!.mathEnabled, true);
      assert.match(exported.markdown, /求 \$x_i\^2\$/);
      assert.match(exported.markdown, /售价 \\\$10/);
      assert.match(exported.markdown, /费用 \\\$10/);
      if (mode === 'blank') assert.doesNotMatch(exported.markdown, /\\frac/);
    }
    const attempt = createAttempt(store, paper);
    submitAttempt(store, attempt, {
      formula: { value: '$x=1$', mathEnabled: true },
      currency: { value: '支出 $5' },
    });
    const completed = attemptExportDocument(attempt);
    assert.equal(completed.questions[0]!.answerMathEnabled, true);
    assert.match(completed.markdown, /\$x=1\$/);
    assert.match(completed.markdown, /支出 \\\$5/);
    assert.equal(attempt.answers.formula!.mathEnabled, true);
  } finally {
    store.db.close();
  }
});
test('JSON migration retains formula modes across source versions, notes and historical answers', () => {
  const source = new Store(':memory:'),
    target = new Store(':memory:');
  try {
    const q = question('migration', { mathEnabled: true, stemMarkdown: '$x+1$' });
    source.put('questions', q.id, q);
    const doc = {
      ...documentSchema.parse({ title: '教材', mathEnabled: true, bodyMarkdown: '$x+1$' }),
      id: 'book',
    };
    source.put('documents', doc.id, doc);
    captureDocumentVersion(source, doc);
    source.putStudy({ ...source.study(q.id), notes: '$x$', notesMathEnabled: true });
    const paper = buildPaper(source, {
        title: '测试',
        mode: 'manual',
        questionIds: [q.id],
        scoring: { enabled: false },
      }),
      attempt = createAttempt(source, paper);
    submitAttempt(source, attempt, { [q.id]: { value: '$x$', mathEnabled: true } });
    importData(target, exportData(source));
    assert.equal(target.require<Question>('questions', q.id).mathEnabled, true);
    assert.equal(target.study(q.id).notesMathEnabled, true);
    assert.equal(exportData(target).documentVersions![0]!.mathEnabled, true);
    assert.equal(exportData(target).attempts![0]!.answers[q.id]!.mathEnabled, true);
  } finally {
    source.db.close();
    target.db.close();
  }
});
test('new AI questions opt into formulas and malformed generated math fails before import', () => {
  assert.match(AI_MATH_INSTRUCTIONS, /JSON/);
  assert.equal(prepareAiQuestionMath(question('ai', { stemMarkdown: '$x^2$' })).mathEnabled, true);
  const input = aiImportInputSchema.parse({ mode: 'generate', text: '材料', count: 1 });
  assert.throws(
    () =>
      finalizeImport(input, {
        questions: [question('bad', { mathEnabled: true, stemMarkdown: '$\\frac{1}{$' })],
        taxonomySuggestions: { domains: [], categories: [], tags: [] },
      }),
    /公式无法排版/,
  );
});

test('group material, per-part formula overrides and shared papers retain distinct modes', () => {
  const source = new Store(':memory:'),
    target = new Store(':memory:');
  try {
    const base = {
      type: 'short_answer' as const,
      title: '小题',
      answerMarkdown: '结论',
      explanationMarkdown: '',
      options: [],
      correctAnswers: [],
    };
    const group = question('G', {
      type: 'group',
      mathEnabled: true,
      stemMarkdown: '公共材料 $x^2$。',
      answerMarkdown: '',
      parts: [
        { ...base, id: 'cash', mathEnabled: false, stemMarkdown: '预算 $10，余额 $2。' },
        { ...base, id: 'math', stemMarkdown: '求 $x^2$。' },
      ],
    });
    source.put('questions', group.id, group);
    const paper = buildPaper(source, {
      title: '组合公式',
      description: '',
      mode: 'manual',
      questionIds: ['G'],
      scoring: { enabled: false },
    });
    source.put('papers', paper.id, paper);
    const exported = paperExportDocument(paper, 'answers');
    assert.equal(exported.questions[0]!.groupMathEnabled, true);
    assert.equal(exported.questions[0]!.mathEnabled, false);
    assert.equal(exported.questions[1]!.mathEnabled, true);
    assert.match(exported.markdown, /公共材料 \$x\^2\$/);
    assert.match(exported.markdown, /预算 \\\$10/);
    importShare(target, exportShare(source, { kind: 'paper', id: paper.id }));
    const imported = target.all<{ snapshot: Question[] }>('papers')[0]!;
    assert.equal(imported.snapshot[0]!.mathEnabled, true);
    assert.equal(imported.snapshot[0]!.parts![0]!.mathEnabled, false);
    assert.equal(imported.snapshot[0]!.parts![1]!.mathEnabled, undefined);
  } finally {
    source.db.close();
    target.db.close();
  }
});
