import type { FastifyInstance } from 'fastify';
import { Store, makeId, now } from '../../core/store.js';
import { bulkQuestionImportSchema, fail, parse, questionSchema } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/routes.js';

export function assertNewQuestionId(qid?: string) {
  if (qid && ['new', 'review', 'import', 'import-template'].includes(qid)) fail(400, 'QUESTION_ID_RESERVED', `题号 ${qid} 为系统操作保留，请使用其他自定义题号或省略ID自动生成`);
}
const examples = [
  { title: '示例：说明概念的适用边界', type: 'short_answer', stemMarkdown: '请选择一个熟悉的概念，说明定义、适用条件与一个反例。', answerMarkdown: '先定义概念，再说明适用条件，用具体例子和反例验证边界。', explanationMarkdown: '请将示例替换为自己的题目、答案和追问。' },
  { title: '示例：判断题', type: 'true_false', stemMarkdown: '仅凭一个成功案例，就能证明方案适用于所有场景。', correctAnswers: ['false'], answerMarkdown: '错误。', explanationMarkdown: '单一成功案例无法覆盖所有条件，应检查前提与反例。' },
  { title: '示例：单选题', type: 'single_choice', stemMarkdown: '发现结论与观测不一致时，应优先做什么？', options: [{ key: 'A', text: '核对前提、数据和复现过程' }, { key: 'B', text: '忽略不同的观测' }, { key: 'C', text: '直接推广原结论' }], correctAnswers: ['A'], answerMarkdown: 'A。', explanationMarkdown: '先验证信息和适用条件，避免凭预期筛掉反例。' },
  { title: '示例：多选题', type: 'multiple_choice', stemMarkdown: '哪些做法有助于检查一个技术结论？', options: [{ key: 'A', text: '核对原始来源与版本' }, { key: 'B', text: '构造边界条件和反例' }, { key: 'C', text: '只保留支持结论的数据' }], correctAnswers: ['A', 'B'], answerMarkdown: 'A、B。', explanationMarkdown: '来源、版本与反例有助于验证结论；筛掉相反数据会导致偏差。' },
  { title: '示例：填空题', type: 'fill_blank', stemMarkdown: '常见的可靠、有序的传输层协议，其英文缩写为【空1】。', blanks: [{ id: 'protocol', label: '空1：协议缩写', answers: ['TCP'], caseSensitive: false, trim: true }], answerMarkdown: 'TCP。', explanationMarkdown: '空位按照数组顺序匹配；本题忽略大小写并去除首尾空白。别名可以在 answers 中列出，按字面匹配，不支持正则表达式。' },
  { title: '示例：论述 / 写作题', type: 'essay', stemMarkdown: '为一个本地学习网站撰写数据备份与恢复方案，说明目标、约束、执行步骤、验证方法和失败处理。', answerMarkdown: '应覆盖备份范围、一致性、版本兼容、恢复演练、失败回滚以及用户可理解的操作流程。', explanationMarkdown: '这是长篇主观题示例。可将评分维度写入参考答案；提交后由用户人工评分，AI 阅卷仅为预留接口。' },
  { title: '示例：公共材料与独立小题', type: 'group', stemMarkdown: '阅读下列 JavaScript 程序，分别完成各小题。\n\n```js\nconst values = [1, 2, 3];\nconst doubled = values.map(n => n * 2);\n```', parts: [
    { id: 'result', title: '小题1：计算结果', type: 'single_choice', stemMarkdown: 'doubled 的内容是什么？', options: [{ key: 'A', text: '[2, 4, 6]' }, { key: 'B', text: '[1, 2, 3]' }], correctAnswers: ['A'], answerMarkdown: 'A。', explanationMarkdown: 'map 为每个元素应用映射函数，并返回结果数组。', weight: 1 },
    { id: 'original', title: '小题2：说明原数组状态', type: 'short_answer', stemMarkdown: '上述代码执行后，values 的内容是什么？说明原因。', answerMarkdown: 'values 仍为 [1, 2, 3]。该回调只计算数值，没有修改原数组；map 返回新数组。', explanationMarkdown: '应结合具体回调判断副作用，不能笼统推断任意 map 回调都不会修改外部对象。', weight: 2 },
  ] },
];

export function registerQuestionBankRoutes(app: FastifyInstance, store: Store) {
  // Register the static import route before /questions/:id, also for the
  // offline route adapter, which preserves registration order.
  app.get('/api/questions/import-template', async (_request, reply) => reply.header('Content-Disposition', 'attachment; filename="new-questions-template.json"').send({
    format: 'learning-new-questions', schemaVersion: 1,
    questions: examples.map(example => ({ ...parse(questionSchema, example), status: 'pending' })),
  }));
  app.post('/api/questions/bulk-import', async (request, reply) => {
    const { data } = parse(bulkQuestionImportSchema, request.body);
    const result = store.transaction(() => {
      const stamp = now();
      const entries = data.questions.map(input => {
        assertNewQuestionId(input.id);
        store.validateRefs(input);
        validateAssetReferences(store, input);
        const qid = input.id || makeId('q');
        if (store.get('questions', qid)) fail(409, 'ID_EXISTS', `题号已存在，未覆盖现有题目：${qid}`);
        return { ...input, id: qid, status: 'pending' as const, createdAt: stamp, updatedAt: stamp };
      });
      // The envelope checks explicitly supplied IDs. Check generated IDs too
      // before writing so every successful response is a complete atomic batch.
      if (new Set(entries.map(q => q.id)).size !== entries.length) fail(409, 'ID_EXISTS', '生成的题号冲突，请重试');
      for (const q of entries) store.insert('questions', q.id, q);
      return { added: entries.length, items: entries.map(q => store.question(q.id)) };
    });
    return reply.code(201).send(result);
  });
}
