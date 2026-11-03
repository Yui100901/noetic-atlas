import { DirectionalGradingRequirements } from './question-grading';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import type { ConceptData, VocabularyData } from '../../../shared/models/types';
import { QuestionMeta, Tags, useApp } from '../../shared/ui/components';
import {
  QuestionContent,
  SourceNoticeScope,
  questionNoticeContents,
} from '../../shared/ui/content-notices';
import { QuestionStructuredBody } from './question-structure';
import type { QuestionSnapshot } from './question-viewer';

/** Both library and set readers use the same body. Only its trusted content
 * source and surrounding navigation differ. Answers remain user-controlled. */
export function QuestionReading({
  question,
  answerOpen,
  onToggle,
  title = false,
  className = 'card question-body',
  reverse = false,
  vocabulary = question.vocabulary,
  concept = question.concept,
}: {
  question: QuestionSnapshot;
  answerOpen: boolean;
  onToggle: () => void;
  title?: boolean;
  className?: string;
  reverse?: boolean;
  vocabulary?: VocabularyData;
  concept?: ConceptData;
}) {
  const { bootstrap } = useApp();
  return (
    <SourceNoticeScope
      mathEnabled={question.mathEnabled}
      contents={questionNoticeContents(question)}
    >
      <section className={className}>
        {reverse ? (
          <span className="badge">{concept ? '概念逆向复习' : '词汇逆向复习'}</span>
        ) : (
          <QuestionMeta question={question} />
        )}
        {title && (
          <h3 className="question-viewer-title">
            {reverse ? (concept ? '看描述想概念' : '看释义想词') : question.title}
          </h3>
        )}
        {!reverse && (
          <div className="taxonomy-path">
            {question.categoryIds.map((categoryId) => {
              const category = bootstrap.categories.find((c) => c.id === categoryId);
              const domain = bootstrap.domains.find((d) => d.id === category?.domainId);
              return (
                category && (
                  <span key={categoryId}>
                    {domain?.name}
                    <ChevronRight size={11} />
                    {category.name}
                  </span>
                )
              );
            })}
          </div>
        )}
        {question.groupStemMarkdown && (
          <section className="group-material">
            <span className="section-label">共用材料 · {question.groupTitle}</span>
            <QuestionContent mathEnabled={question.groupMathEnabled ?? question.mathEnabled}>
              {question.groupStemMarkdown}
            </QuestionContent>
          </section>
        )}
        <QuestionContent questionType={question.type}>
          {reverse
            ? concept?.meaningPrompt || vocabulary?.meaningPrompt || ''
            : question.stemMarkdown}
        </QuestionContent>
        {!!question.options.length && (
          <div className="read-options">
            {question.options.map((option) => (
              <div key={option.key}>
                <strong>{option.key}</strong>
                <QuestionContent>{option.text}</QuestionContent>
              </div>
            ))}
          </div>
        )}
        {!reverse && (
          <>
            <QuestionStructuredBody question={{ ...question, vocabulary }} />
            {!question.vocabulary && vocabulary && (
              <p className="muted">读音补充来自当前词卡；题目正文仍为题集快照。</p>
            )}
            <Tags ids={question.tagIds} max={30} />
          </>
        )}
        <div className="answer-toggle">
          <button
            type="button"
            className={`button ${answerOpen ? '' : 'primary'}`}
            aria-expanded={answerOpen}
            onClick={onToggle}
          >
            <BookOpen size={17} />
            {answerOpen ? '收起参考答案' : '展开答案与解析'}
            <ChevronDown size={15} className={answerOpen ? 'rotated' : ''} />
          </button>
        </div>
        {answerOpen && (
          <div className="answer-content" id="reference-answer">
            <div className="section-label">
              参考答案
              {question.correctAnswers.length
                ? ' · ' +
                  question.correctAnswers
                    .map((v) => (v === 'true' ? '对' : v === 'false' ? '错' : v))
                    .join('、')
                : ''}
            </div>
            {reverse && (
              <>
                <p>
                  <strong>{concept ? '目标概念：' : '目标词语：'}</strong>
                  {concept?.term || vocabulary?.headword || ''}
                </p>
                <QuestionStructuredBody question={{ ...question, vocabulary }} />
              </>
            )}
            <QuestionStructuredBody question={question} showAnswers />
            <QuestionContent>{question.answerMarkdown}</QuestionContent>
            <DirectionalGradingRequirements
              question={question}
              direction={reverse ? 'meaning_to_word' : undefined}
              mathEnabled={question.mathEnabled}
            />
            {question.explanationMarkdown && (
              <>
                <div className="section-label">解析 · 追问 · 误区</div>
                <QuestionContent>{question.explanationMarkdown}</QuestionContent>
              </>
            )}
          </div>
        )}
      </section>
    </SourceNoticeScope>
  );
}
