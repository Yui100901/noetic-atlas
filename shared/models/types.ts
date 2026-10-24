import type { SystemSettings } from './settings.js';
export type QuestionType = 'short_answer' | 'true_false' | 'single_choice' | 'multiple_choice' | 'fill_blank' | 'essay' | 'group';
export type LeafQuestionType = Exclude<QuestionType, 'group'>;
export interface BlankSpec { id: string; label: string; answers: string[]; caseSensitive: boolean; trim: boolean }
export interface QuestionPart { id: string; title: string; type: LeafQuestionType; stemMarkdown: string; answerMarkdown: string; explanationMarkdown: string; options: Option[]; correctAnswers: string[]; blanks?: BlankSpec[]; weight?: number }
export type Collection = 'general' | 'personal';
export interface Domain { id: string; name: string; description: string; sortOrder: number }
export interface Category { id: string; domainId: string; parentId: string | null; name: string; description: string; sortOrder: number }
export type TagKind = 'topic' | 'method' | 'custom';
export interface Tag { id: string; name: string; color: string; description: string; domainId?: string | null; kind?: TagKind }
export type QuestionStatus = 'published' | 'pending' | 'draft' | 'archived';
export interface SourceRef { label: string; url: string }
export interface Option { key: string; text: string }
export interface StudyState { questionId: string; partId?: string; favorite: boolean; mastery: number | null; notes: string; nextReviewAt: string | null; lastReviewedAt: string | null; wrongCount: number }
export interface Question {
  id: string; title: string; type: QuestionType; stemMarkdown: string;
  answerMarkdown: string; explanationMarkdown: string; options: Option[]; correctAnswers: string[];
  blanks?: BlankSpec[]; parts?: QuestionPart[];
  difficulty: number; depth: number; frequency: number; frequencyScope: string; frequencyBasis: string;
  collection: Collection; status: QuestionStatus;
  categoryIds: string[]; tagIds: string[]; sourceRefs: SourceRef[];
  sourceDocument: string | null; sourceAnchor: string | null;
  createdAt?: string; updatedAt?: string; study?: StudyState; partStudies?: StudyState[];
}
export type QuestionInput = Omit<Question, 'id' | 'createdAt' | 'updatedAt' | 'study' | 'partStudies'> & { id?: string };
export interface QuestionPage { items: Question[]; total: number; page: number; pageSize: number }
export interface QuestionReviewInput { ids: string[]; action: 'approve' | 'return_to_draft'; confirmed: true; expectedUpdatedAt: Record<string, string> }
export interface PendingQuestionExport { format: 'learning-pending-questions'; schemaVersion: 1; exportedAt: string; questions: Question[] }
export interface NewQuestionImport { format: 'learning-new-questions'; schemaVersion: 1; questions: QuestionInput[] }
export interface QuestionBank { id: string; name: string; description: string; questionIds: string[]; createdAt?: string; updatedAt?: string }
export interface DocumentRecord { id: string; title: string; kind: string; bodyMarkdown: string; collection: Collection; categoryIds: string[]; tagIds: string[]; sourcePath: string | null; updatedAt?: string; format?: 'markdown' | 'pdf'; assetId?: string | null; fileName?: string | null; domainIds?: string[]; author?: string; publisher?: string; publishedYear?: string; description?: string }
export interface PaperFilters { tagIds?: string[]; tagMode?: 'all' | 'any'; categoryId?: string; domainId?: string; paperId?: string; types?: QuestionType[]; difficultyMin?: number; difficultyMax?: number; frequencyMin?: number; collection?: Collection | 'all' }
export interface ScoringInput { enabled: boolean; totalPoints?: number; questionPoints?: Record<string, number>; objectivePercent?: number; pointsByType?: Partial<Record<QuestionType, number>> }
export interface PaperScoring {
  enabled: boolean; scheme: 'legacy' | 'custom' | 'none'; totalPoints: number;
  questionPoints: Record<string, number>; objectivePercent: number; actualObjectivePercent: number;
  objectivePoints: number; subjectivePoints: number; pointsByType: Record<QuestionType, number>;
}
export interface Paper { legacyBankId?: string; organization?: 'domain' | 'other'; domainId?: string | null; id: string; title: string; description: string; mode: 'manual' | 'random'; questionIds: string[]; questionCount: number; filters: PaperFilters | null; archived: boolean; version: number; createdAt: string; updatedAt: string; scoring?: PaperScoring }
export interface ExamQuestion { id: string; title: string; type: QuestionType; stemMarkdown: string; options: Option[]; difficulty: number; depth: number; frequency: number; collection: Collection; sourceQuestionId: string; points?: number; blanks?: Omit<BlankSpec, 'answers'>[]; groupId?: string; groupTitle?: string; groupStemMarkdown?: string; partId?: string; partIndex?: number }
export interface PaperDetail extends Paper { questions: ExamQuestion[]; answerCount?: number }
export type AnswerVerdict = 'correct' | 'partial' | 'incorrect';
export interface AttemptAnswer { value: string | string[]; selfScore?: number | null; mastery?: number | null; verdict?: AnswerVerdict | null }
export interface AttemptQuestion extends ExamQuestion { answerMarkdown?: string; explanationMarkdown?: string; correctAnswers?: string[]; sourceRefs?: SourceRef[] }
export interface Attempt { answerStates?: Record<string, 'unanswered' | 'answered' | 'correct' | 'partial' | 'incorrect' | 'ungraded'>; practiceMode?: 'practice' | 'exam'; durationMinutes?: number | null; deadlineAt?: string | null; elapsedSeconds?: number; autoSubmitted?: boolean; id: string; paperId: string; paperTitle: string; paperVersion: number; source?: 'paper' | 'quick'; referenceViewedAt?: string | null; status: 'in_progress' | 'submitted'; questions: AttemptQuestion[]; answers: Record<string, AttemptAnswer>; objectiveScore: number; objectiveMax: number; subjectiveScore: number; subjectiveMax: number; startedAt: string; updatedAt?: string; submittedAt: string | null; scoring?: PaperScoring; gradedSubjectiveCount?: number; pendingSubjectiveCount?: number; gradingStatus?: 'not_applicable' | 'pending' | 'partial' | 'complete'; totalScore?: number | null }
export interface Bootstrap { settings?: SystemSettings; domains: Domain[]; categories: Category[]; tags: Tag[]; stats: { totalQuestions: number; generalQuestions: number; personalQuestions: number; totalPapers: number; totalDocuments: number; favoriteCount: number; dueCount: number; wrongCount: number; typeCounts: Record<string, number> }; ai: { available: boolean; message: string } }
export interface SeedData { schemaVersion: 1; generatedAt: string; domains: Domain[]; categories: Category[]; tags: Tag[]; questions: Question[]; questionBanks?: QuestionBank[]; documents: DocumentRecord[]; papers: Array<{ id: string; title: string; description: string; questionIds: string[]; mode: 'manual'; filters: null; scoring?: PaperScoring }> }
export const typeLabels: Record<QuestionType, string> = { short_answer: '简答 / 场景', true_false: '判断', single_choice: '单选', multiple_choice: '多选', fill_blank: '填空', essay: '论述 / 写作', group: '组合题（公共材料）' };
