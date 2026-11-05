/** All content is synthetic and only written through the .qa app's local API. */
export async function seedAndroidLayout(api) {
  const domain = await api('/api/domains', 'POST', { name: '安卓布局测试', id: 'android-layout' });
  const category = await api('/api/categories', 'POST', {
    name: '长标题与基础概念的自适应测试分类',
    id: 'android-layout-category',
    domainId: domain.id,
  });
  const tag = await api('/api/tags', 'POST', {
    id: 'android-layout-tag',
    name: '并发与事务边界',
    domainId: domain.id,
    kind: 'topic',
    color: '#39C5BB',
  });
  const questions = [];
  for (let i = 0; i < 16; i++)
    questions.push(
      await api('/api/questions', 'POST', {
        id: 'ANDROID-LAYOUT-' + i,
        title: i === 0 ? '长题目标题：事务边界与隔离性在移动端的显示检查' : '安卓基础题 ' + i,
        type: i === 0 ? 'short_answer' : 'true_false',
        stemMarkdown:
          i === 0
            ? '说明事务原子性。\n\n| 性质 | 含义 |\n|---|---|\n| 原子性 | 整体提交或回滚 |\n\n```ts\nconst transactionBoundary = "this_is_a_long_program_line_for_horizontal_scroll_without_page_overflow";\n```\n\n公式 $E=mc^2$。'
            : '已提交事务应保留持久化结果。',
        mathEnabled: i === 0,
        answerMarkdown: '整体提交或回滚。',
        gradingRequirements:
          i === 0 ? '说明整体提交或整体回滚，结合转账说明失败时撤销两项修改。' : '',
        correctAnswers: i === 0 ? [] : ['true'],
        categoryIds: [category.id],
        tagIds: [tag.id],
      }),
    );
  questions.push(
    await api('/api/questions', 'POST', {
      id: 'ANDROID-LAYOUT-GROUP',
      title: '程序阅读组合题',
      type: 'group',
      stemMarkdown: 'const values = [1, 2, 3];',
      categoryIds: [category.id],
      parts: [
        {
          id: 'sum',
          title: '求和',
          type: 'single_choice',
          stemMarkdown: '数组之和是多少？',
          options: [
            { key: 'A', text: '6' },
            { key: 'B', text: '7' },
          ],
          correctAnswers: ['A'],
        },
        {
          id: 'count',
          title: '数组长度',
          type: 'fill_blank',
          stemMarkdown: '数组长度为____。',
          blanks: [{ id: 'count', label: '长度', answers: ['3'] }],
        },
      ],
    }),
  );
  await api('/api/questions/review', 'POST', {
    ids: questions.map((q) => q.id),
    action: 'approve',
    confirmed: true,
    expectedUpdatedAt: Object.fromEntries(questions.map((q) => [q.id, q.updatedAt])),
  });
  await api('/api/questions', 'POST', {
    id: 'ANDROID-LAYOUT-PENDING',
    title: '待审核题目',
    type: 'true_false',
    stemMarkdown: '事务应具有原子性。',
    correctAnswers: ['true'],
    categoryIds: [category.id],
  });
  const paper = await api('/api/papers', 'POST', {
    title: '移动端长标题题集：基础知识与程序阅读',
    mode: 'manual',
    questionIds: questions.map((q) => q.id),
    scoring: { enabled: false },
  });
  const history = await api('/api/papers/' + paper.id + '/attempts', 'POST', {});
  const submitted = await api('/api/attempts/' + history.id + '/submit', 'POST', {
    answers: Object.fromEntries(
      questions.filter((q) => q.type === 'true_false').map((q) => [q.id, { value: 'false' }]),
    ),
  });
  const draft = await api('/api/papers/' + paper.id + '/attempts', 'POST', {});
  await api('/api/study/' + questions[0].id, 'PUT', {
    favorite: true,
    notes: '只有查看时显示的合成学习笔记。',
  });
  const doc = await api('/api/documents', 'POST', {
    title: '移动端资料编辑与原文阅读测试',
    kind: '书籍',
    format: 'markdown',
    bodyMarkdown:
      '# 布局检查\n\n## 基础概念\n\n合成资料，检查移动端资料阅读与编辑。\n\n- 事务\n- 并发',
    domainIds: [domain.id],
    categoryIds: [category.id],
  });
  const focus = await api('/api/focus-sessions', 'POST', {
    paperId: paper.id,
    scope: 'all',
    count: 3,
  });
  await api('/api/question-feedback', 'POST', {
    questionId: questions[0].id,
    kind: 'answer',
    description: '核对本题答案与适用边界。',
  });
  return {
    paperId: paper.id,
    draftId: draft.id,
    submittedId: submitted.id,
    documentId: doc.id,
    focusId: focus.id,
  };
}
