/** These catalog explanations use standalone A–D only as option labels.
 * Rotate multiple-choice layouts and references together; no question text,
 * definition, mathematical variable or source URL is transformed. */
export function balanceMultipleChoiceLayouts(groups) {
  let sequence = 0;
  return groups.map(group => ({ ...group, questions: group.questions.map(question => {
    if (question.type !== 'multiple_choice') return question;
    const offset = sequence++ % 4;
    const keys = Object.fromEntries([...'ABCD'].map((key, position) => [key, 'ABCD'[(position + offset) % 4]]));
    let explanation = question.explanation.replaceAll('A至C', '正确选项').replaceAll('前三项', '正确选项').replaceAll('最后一种', '错误选项所述的情况').replaceAll('最后一项', '错误选项');
    explanation = explanation.replace(/(?<![A-Za-z0-9])([ABCD])(?![A-Za-z0-9])/g, (_, letter) => keys[letter]);
    const options = question.options.map((text, index) => ({ text, key: keys['ABCD'[index]] })).sort((a, b) => a.key.localeCompare(b.key)).map(option => option.text);
    return { ...question, options, correct: question.correct.map(key => keys[key]).sort(), explanation };
  }) }));
}
