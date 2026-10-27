import type { ConceptData } from '../models/types.js';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A separately authored definition, never a reversal of explanations/examples. */
export function conceptPromptIsSafe(value: ConceptData): boolean {
  const prompt = normalize(value.meaningPrompt);
  if (!prompt || /https?:|#\/|!?\[|<[^>]*>|```/.test(prompt)) return false;
  return [value.term, ...value.acceptedAnswers].every(raw => {
    const token = normalize(raw);
    if (!token) return false;
    return /^[a-z0-9' .+#-]+$/i.test(token)
      ? !new RegExp(`(^|[^a-z0-9])${escape(token)}($|[^a-z0-9])`, 'i').test(prompt)
      : !prompt.includes(token);
  });
}
