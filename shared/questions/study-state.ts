import type { StudyState } from '../models/types.js';

/** A tuple encoding keeps arbitrary source/part IDs unambiguous. */
export const studyPartKey = (questionId: string, partId: string) => JSON.stringify([questionId, partId]);
export const emptyStudy = (questionId: string, partId?: string): StudyState => ({ questionId, ...(partId === undefined ? {} : { partId }), favorite: false, mastery: null, notes: '', nextReviewAt: null, lastReviewedAt: null, wrongCount: 0 });
