import type { Question } from '../../../shared/models/types';
import {
  QuestionContent,
  SourceNoticeScope,
  questionNoticeContents,
} from '../../shared/ui/content-notices';
import { QuestionStructuredBody } from './question-structure';

// Preview saved, validated questions in place. Internal reference links must
// not abandon an in-progress paper; answers remain collapsed until requested.
export function QuestionPreview({ question }: { question: Question }) {
  return (
    <SourceNoticeScope contents={questionNoticeContents(question)}>
      <div
        className="question-inline-preview"
        onClickCapture={(event) => {
          const link = (event.target as HTMLElement).closest('a');
          if (link?.getAttribute('href')?.startsWith('#/')) event.preventDefault();
        }}
      >
        <QuestionContent questionType={question.type}>{question.stemMarkdown}</QuestionContent>
        {question.options.map((option) => (
          <div key={option.key}>
            <strong>{option.key}</strong>
            <QuestionContent>{option.text}</QuestionContent>
          </div>
        ))}
        <QuestionStructuredBody question={question} />
        <details>
          <summary>参考答案与解析</summary>
          <QuestionContent>{question.answerMarkdown}</QuestionContent>
          <p>
            {question.correctAnswers
              .map((value) => (value === 'true' ? '正确' : value === 'false' ? '错误' : value))
              .join('、')}
          </p>
          <QuestionStructuredBody question={question} showAnswers />
          <QuestionContent>{question.explanationMarkdown}</QuestionContent>
        </details>
      </div>
    </SourceNoticeScope>
  );
}
