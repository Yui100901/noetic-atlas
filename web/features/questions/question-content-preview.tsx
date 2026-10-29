import { typeLabels, type QuestionType } from '../../../shared/models/types';
import {
  QuestionContent,
  questionNoticeContents,
  SourceNoticeScope,
} from '../../shared/ui/content-notices';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const values = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const records = (value: unknown) => (Array.isArray(value) ? value.map(object) : []);

/** Import previews are not trusted saved questions. Render incomplete JSON
 * defensively, including structured answers; persistence still validates it. */
export function QuestionContentPreview({ question }: { question: unknown }) {
  const root = object(question);
  const parts = records(root.parts);
  const notices = {
    stemMarkdown: text(root.stemMarkdown),
    answerMarkdown: text(root.answerMarkdown),
    explanationMarkdown: text(root.explanationMarkdown),
    options: records(root.options).map((option) => ({ text: text(option.text) })),
    parts: parts.map((part) => ({
      stemMarkdown: text(part.stemMarkdown),
      answerMarkdown: text(part.answerMarkdown),
      explanationMarkdown: text(part.explanationMarkdown),
      options: records(part.options).map((option) => ({ text: text(option.text) })),
    })),
  };
  const content = (item: Record<string, unknown>) => {
    const type = text(item.type),
      answers = values(item.correctAnswers),
      blanks = records(item.blanks);
    const hasAnswer =
      !!text(item.answerMarkdown).trim() ||
      answers.length > 0 ||
      blanks.some((blank) => values(blank.answers).length > 0);
    return (
      <>
        <QuestionContent questionType={type}>{text(item.stemMarkdown)}</QuestionContent>
        {records(item.options).map((option, index) => (
          <div className="part-reading-option" key={index}>
            <strong>{text(option.key)}.</strong>
            <QuestionContent>{text(option.text)}</QuestionContent>
          </div>
        ))}
        {type !== 'group' && (
          <section className="candidate-reference-answer">
            <h4>参考答案</h4>
            {answers.length > 0 && (
              <p>
                <strong>{type === 'true_false' ? '正确判断：' : '正确选项：'}</strong>
                {answers
                  .map((value) =>
                    type === 'true_false'
                      ? value === 'true'
                        ? '正确'
                        : value === 'false'
                          ? '错误'
                          : value
                      : value,
                  )
                  .join('、')}
              </p>
            )}
            {blanks.length > 0 && (
              <div className="question-blank-hints">
                {blanks.map((blank, index) => (
                  <div key={index}>
                    <strong>
                      {index + 1}. {text(blank.label) || `第${index + 1}空`}
                    </strong>
                    <span>{values(blank.answers).join(' / ') || '尚未填写答案'}</span>
                    <small>
                      {blank.caseSensitive ? '区分大小写' : '不区分大小写'} ·{' '}
                      {blank.trim === false ? '保留首尾空白' : '忽略首尾空白'}
                    </small>
                  </div>
                ))}
              </div>
            )}
            <QuestionContent>{text(item.answerMarkdown)}</QuestionContent>
            {!hasAnswer && <p className="muted">尚未填写参考答案，请在导入前核对。</p>}
          </section>
        )}
        {type === 'group' && text(item.answerMarkdown) && (
          <>
            <h4>公共答案说明</h4>
            <QuestionContent>{text(item.answerMarkdown)}</QuestionContent>
          </>
        )}
        {text(item.explanationMarkdown) && (
          <>
            <h4>解析与追问</h4>
            <QuestionContent>{text(item.explanationMarkdown)}</QuestionContent>
          </>
        )}
      </>
    );
  };
  return (
    <SourceNoticeScope contents={questionNoticeContents(notices)}>
      <div className="question-content-preview">
        {content(root)}
        {text(root.type) === 'group' &&
          parts.map((part, index) => (
            <section className="question-part-reading" key={index}>
              <h4>
                小题 {index + 1} · {text(part.title) || '未命名小题'}
              </h4>
              <span className="badge">
                {typeLabels[text(part.type) as QuestionType] || text(part.type)}
              </span>
              {content(part)}
            </section>
          ))}
      </div>
    </SourceNoticeScope>
  );
}
