import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { Plus, Trash2, Undo2 } from 'lucide-react';
import type {
  QuestionInput,
  VocabularyData,
  VocabularyPronunciation as Pronunciation,
} from '../../../shared/models/types';
import { normalizeVocabularyData, vocabularyIssues } from '../../../shared/questions/vocabulary';
import {
  forwardCardGradingTitle,
  reverseCardGradingRequirements,
  reverseCardGradingTitle,
} from '../../../shared/questions/directional-grading';
import { Field } from '../../shared/ui/components';
import { QuestionContent } from '../../shared/ui/content-notices';
import { QuestionGradingRequirements } from './question-grading';
import { VocabularyPronunciation } from './vocabulary-pronunciation';
import { VocabularyPromptMatches } from './vocabulary-prompt-matches';
import {
  newVocabularyData,
  previewVocabularyMatch,
  renameVocabularyHeadword,
  vocabularyTextPatch,
} from './vocabulary-editor-state';
import './vocabulary-editor.css';

type Props = {
  question: QuestionInput;
  onChange: (patch: Partial<QuestionInput>) => void;
  disabled?: boolean;
};

export function VocabularyEditor({ question, onChange, disabled = false }: Props) {
  const value = question.vocabulary;
  const [previousText, setPreviousText] = useState<{
    before: Pick<QuestionInput, 'title' | 'stemMarkdown'>;
    applied: Pick<QuestionInput, 'title' | 'stemMarkdown'>;
  } | null>(null);
  const update = (patch: Partial<VocabularyData>) => {
    if (value) onChange({ vocabulary: { ...value, ...patch } });
  };
  const pronunciation = (index: number, patch: Partial<Pronunciation>) => {
    if (value)
      update({
        pronunciations: value.pronunciations.map((item, i) =>
          i === index ? { ...item, ...patch } : item,
        ),
      });
  };
  const issues = value ? vocabularyIssues(normalizeVocabularyData(value)) : [];
  const undoAvailable =
    previousText &&
    question.title === previousText.applied.title &&
    question.stemMarkdown === previousText.applied.stemMarkdown;
  return (
    <section className="vocabulary-editor form-stack" aria-label="词汇卡专用编辑">
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={!!value}
          disabled={disabled}
          onChange={(event) => {
            setPreviousText(null);
            onChange(
              event.target.checked
                ? { vocabulary: newVocabularyData(question.title), concept: undefined }
                : { vocabulary: undefined },
            );
          }}
        />
        作为词汇卡
      </label>
      {value && (
        <>
          <p className="muted">
            词汇卡仍属于简答题。下方参考答案保存词性与义项，详细解析保存例句、搭配及辨析。
          </p>
          <div className="vocabulary-editor-grid">
            <Field label="词卡语言">
              <select
                value={value.language}
                disabled={disabled}
                onChange={(event) =>
                  update({ language: event.target.value as VocabularyData['language'] })
                }
              >
                <option value="en">英语</option>
                <option value="ja">日语</option>
              </select>
            </Field>
            <Field
              label="词条 *"
              hint="更名会替换允许答案中的原主词，其他别名保留。请核对保留的别名是否仍适用。"
            >
              <input
                required
                maxLength={300}
                value={value.headword}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ vocabulary: renameVocabularyHeadword(value, event.target.value) })
                }
                lang={value.language}
              />
            </Field>
            <Field label="词性" hint="可选，如 v.、n.、名词、五段动词；多个词性应与答案义项对应。">
              <input
                maxLength={100}
                value={value.partOfSpeech || ''}
                disabled={disabled}
                onChange={(event) => update({ partOfSpeech: event.target.value })}
                placeholder="例如：v."
              />
            </Field>
          </div>
          <p className="muted">
            切换语言会保留已填内容，请重新核对读音并补齐对应的音标，或假名与罗马音。
          </p>
          <div className="vocabulary-editor-actions">
            <button
              className="button"
              type="button"
              disabled={disabled || !value.headword.trim()}
              onClick={() => {
                const applied = vocabularyTextPatch(value);
                setPreviousText({
                  before: { title: question.title, stemMarkdown: question.stemMarkdown },
                  applied,
                });
                onChange(applied);
              }}
            >
              从词条填写标题与题干
            </button>
            {undoAvailable && (
              <button
                className="button"
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (previousText) onChange(previousText.before);
                  setPreviousText(null);
                }}
              >
                <Undo2 size={15} />
                撤回填写
              </button>
            )}
          </div>
          <div className="vocabulary-pronunciation-editor form-stack">
            <div className="vocabulary-editor-heading">
              <h3>读音</h3>
              <button
                className="button"
                type="button"
                disabled={disabled || value.pronunciations.length >= 40}
                onClick={() =>
                  update({
                    pronunciations: [
                      ...value.pronunciations,
                      {
                        label: value.language === 'en' ? '英式' : '日语',
                        ...(value.language === 'en' ? { ipa: '' } : { kana: '', romaji: '' }),
                        sourceLabel: '',
                        sourceUrl: '',
                        license: '',
                        method: 'manual',
                      },
                    ],
                  })
                }
              >
                <Plus size={15} />
                添加读音
              </button>
            </div>
            {!value.pronunciations.length && (
              <p className="muted">尚未填写读音。可按已核实的词典资料补充，来源信息可选。</p>
            )}
            {value.pronunciations.map((item, index) => (
              <fieldset key={index} className="vocabulary-reading-row" disabled={disabled}>
                <legend>读音 {index + 1}</legend>
                <div className="vocabulary-editor-heading">
                  <Field label={`读音 ${index + 1} 名称`}>
                    <input
                      required
                      maxLength={100}
                      value={item.label}
                      placeholder={value.language === 'en' ? '英式 / 美式' : '日语'}
                      onChange={(event) => pronunciation(index, { label: event.target.value })}
                    />
                  </Field>
                  <button
                    type="button"
                    className="button danger"
                    aria-label={`删除读音 ${index + 1}`}
                    onClick={() =>
                      update({ pronunciations: value.pronunciations.filter((_, i) => i !== index) })
                    }
                  >
                    <Trash2 size={15} />
                    删除
                  </button>
                </div>
                {value.language === 'en' ? (
                  <Field
                    label={`读音 ${index + 1} 音标`}
                    hint="填写已核实的国际音标，如 /əˈbændən/。"
                  >
                    <input
                      required
                      maxLength={1000}
                      value={item.ipa || ''}
                      onChange={(event) => pronunciation(index, { ipa: event.target.value })}
                    />
                  </Field>
                ) : (
                  <div className="vocabulary-editor-grid">
                    <Field label={`读音 ${index + 1} 假名`}>
                      <input
                        required
                        maxLength={1000}
                        lang="ja"
                        value={item.kana || ''}
                        onChange={(event) => pronunciation(index, { kana: event.target.value })}
                      />
                    </Field>
                    <Field label={`读音 ${index + 1} 罗马音`}>
                      <input
                        required
                        maxLength={1000}
                        value={item.romaji || ''}
                        onChange={(event) => pronunciation(index, { romaji: event.target.value })}
                      />
                    </Field>
                  </div>
                )}
                <details className="vocabulary-reading-source">
                  <summary>读音来源与标注方式（可选）</summary>
                  <div className="form-stack">
                    <div className="vocabulary-editor-grid">
                      <Field label={`读音 ${index + 1} 来源名称`}>
                        <input
                          maxLength={500}
                          value={item.sourceLabel}
                          onChange={(event) =>
                            pronunciation(index, { sourceLabel: event.target.value })
                          }
                        />
                      </Field>
                      <Field label={`读音 ${index + 1} 来源地址`}>
                        <input
                          type="url"
                          maxLength={3000}
                          value={item.sourceUrl}
                          onChange={(event) =>
                            pronunciation(index, { sourceUrl: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                    <div className="vocabulary-editor-grid">
                      <Field label={`读音 ${index + 1} 许可说明`}>
                        <input
                          maxLength={300}
                          value={item.license}
                          onChange={(event) =>
                            pronunciation(index, { license: event.target.value })
                          }
                        />
                      </Field>
                      <Field label={`读音 ${index + 1} 标注方式`}>
                        <select
                          value={item.method}
                          onChange={(event) =>
                            pronunciation(index, {
                              method: event.target.value as Pronunciation['method'],
                            })
                          }
                        >
                          <option value="manual">人工补充核对</option>
                          <option value="source">原始资料读音</option>
                          <option value="transliteration">由假名转换罗马音</option>
                          <option value="expanded">按含义展开读法</option>
                        </select>
                      </Field>
                    </div>
                  </div>
                </details>
              </fieldset>
            ))}
          </div>
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={value.reverseEnabled !== false}
              disabled={disabled}
              onChange={(event) => update({ reverseEnabled: event.target.checked })}
            />
            允许看释义想词语
          </label>
          <Field
            label="逆向独立释义提示"
            hint="只写作答所需释义和语境，不含目标词、音标、假名、罗马音、例句答案或链接；关闭逆向时可留空。"
          >
            <textarea
              required={value.reverseEnabled !== false}
              rows={3}
              maxLength={8000}
              value={value.meaningPrompt}
              disabled={disabled}
              onChange={(event) => update({ meaningPrompt: event.target.value })}
              placeholder="例如：动词，表示放弃原有计划或尝试。"
            />
          </Field>
          <VocabularyPromptMatches value={value} questionId={question.id} />
          <Field
            label="逆向可接受答案"
            hint="每行一个已确认的词形；保存时去空、去重并加入词条。其他同义表达不会自动判对，请核对提示是否足够明确。"
          >
            <textarea
              rows={3}
              maxLength={30000}
              value={value.acceptedAnswers.join('\n')}
              disabled={disabled}
              onChange={(event) => update({ acceptedAnswers: event.target.value.split('\n') })}
              lang={value.language}
            />
          </Field>
          <div className="vocabulary-editor-checks">
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={value.caseSensitive === true}
                disabled={disabled}
                onChange={(event) => update({ caseSensitive: event.target.checked })}
              />
              逆向区分大小写
            </label>
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={value.trim !== false}
                disabled={disabled}
                onChange={(event) => update({ trim: event.target.checked })}
              />
              逆向忽略首尾空白
            </label>
          </div>
          <p className="muted">
            独立释义可能对应多个合理词语。请补充词性和语境、收录允许答案，或关闭逆向练习；系统无法仅凭格式校验确认语义唯一。
          </p>
          {!!issues.length && (
            <div className="vocabulary-editor-issues" aria-live="polite">
              {issues.map((issue, index) => (
                <p
                  className={`notice ${issue.severity === 'error' ? 'error' : 'info'}`}
                  key={`${issue.code}-${index}`}
                >
                  {issue.message}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Authoring preview is isolated from learning state and never creates an attempt. */
export function VocabularyPreview({ question }: { question: QuestionInput }) {
  const vocabulary = question.vocabulary ? normalizeVocabularyData(question.vocabulary) : undefined;
  const [reverse, setReverse] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(false);
  const [trial, setTrial] = useState('');
  const [tested, setTested] = useState(false);
  const tabId = useId();
  const metadata = JSON.stringify(vocabulary);
  useEffect(() => {
    setAnswerOpen(false);
    setTested(false);
    setTrial('');
  }, [reverse, metadata]);
  useEffect(() => {
    if (vocabulary?.reverseEnabled === false) setReverse(false);
  }, [vocabulary?.reverseEnabled]);
  if (!vocabulary) return null;
  const reverseUnavailable = vocabulary.reverseEnabled === false;
  const isReverse = reverse && !reverseUnavailable;
  const errors = vocabularyIssues(vocabulary).filter((issue) => issue.severity === 'error');
  const switchTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next =
      !reverseUnavailable && (event.key === 'End' || (event.key !== 'Home' && !isReverse));
    setReverse(next);
    document.getElementById(`${tabId}-${next ? 'reverse' : 'forward'}`)?.focus();
  };
  return (
    <section className="vocabulary-preview form-stack" aria-label="词汇卡双向预览">
      <div className="vocabulary-editor-heading">
        <h3>词汇卡双向预览</h3>
        <span className="muted">仅预览，不计入学习记录</span>
      </div>
      <div className="section-tabs" role="tablist" aria-label="词卡预览方向" onKeyDown={switchTab}>
        <button
          id={`${tabId}-forward`}
          aria-controls={`${tabId}-panel`}
          type="button"
          role="tab"
          aria-selected={!isReverse}
          tabIndex={!isReverse ? 0 : -1}
          className={!isReverse ? 'selected' : ''}
          onClick={() => setReverse(false)}
        >
          看词想义
        </button>
        <button
          id={`${tabId}-reverse`}
          aria-controls={`${tabId}-panel`}
          type="button"
          role="tab"
          aria-selected={isReverse}
          tabIndex={isReverse ? 0 : -1}
          disabled={reverseUnavailable}
          className={isReverse ? 'selected' : ''}
          onClick={() => setReverse(true)}
        >
          看义想词
        </button>
      </div>
      {reverseUnavailable && <p className="muted">此卡已关闭逆向练习。</p>}
      <div
        className="vocabulary-preview-body form-stack"
        id={`${tabId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabId}-${isReverse ? 'reverse' : 'forward'}`}
      >
        {isReverse ? (
          <>
            <p className="section-label">根据独立释义回忆原词卡中的词语</p>
            <p className="vocabulary-preview-prompt">
              {vocabulary.meaningPrompt || '尚未填写独立释义提示。'}
            </p>
            <Field label="试填逆向答案" hint="试判按本卡收录的词形和匹配规则执行。">
              <input
                value={trial}
                maxLength={1000}
                onChange={(event) => {
                  setTrial(event.target.value);
                  setTested(false);
                }}
              />
            </Field>
            <div className="vocabulary-editor-actions">
              <button
                type="button"
                className="button"
                disabled={!!errors.length || !trial.length}
                onClick={() => setTested(true)}
              >
                试判答案
              </button>
              {tested && (
                <span
                  role="status"
                  className={`vocabulary-match-result ${previewVocabularyMatch(vocabulary, trial) ? 'correct' : 'incorrect'}`}
                >
                  {previewVocabularyMatch(vocabulary, trial)
                    ? '匹配：本答案将判为正确'
                    : '未匹配：本答案将判为错误'}
                </span>
              )}
            </div>
            {!!errors.length && (
              <p className="notice error">请先修正上方词卡校验问题，再试判逆向答案。</p>
            )}
          </>
        ) : (
          <QuestionContent questionType="short_answer">
            {question.stemMarkdown || vocabulary.headword || '尚未填写词条。'}
          </QuestionContent>
        )}
        <button
          type="button"
          className="button"
          aria-expanded={answerOpen}
          onClick={() => setAnswerOpen(!answerOpen)}
        >
          {answerOpen ? '收起预览答案' : '展开预览答案与解析'}
        </button>
        {answerOpen && (
          <div className="vocabulary-preview-answer form-stack">
            {isReverse && (
              <p>
                <strong>目标词语：</strong>
                {vocabulary.headword}
              </p>
            )}
            <VocabularyPronunciation vocabulary={vocabulary} />
            <div>
              <p className="section-label">参考答案</p>
              <QuestionContent>{question.answerMarkdown || '尚未填写参考答案。'}</QuestionContent>
            </div>
            {!!question.explanationMarkdown.trim() && (
              <div>
                <p className="section-label">详细解析</p>
                <QuestionContent>{question.explanationMarkdown}</QuestionContent>
              </div>
            )}
            <QuestionGradingRequirements
              title={
                isReverse ? reverseCardGradingTitle(question) : forwardCardGradingTitle(question)
              }
              value={
                isReverse
                  ? reverseCardGradingRequirements({ ...question, vocabulary })
                  : question.gradingRequirements
              }
            />
          </div>
        )}
      </div>
    </section>
  );
}
