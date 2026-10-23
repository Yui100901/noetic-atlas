import type { SeedData } from './types.js';

/** Empty application envelope; content is imported separately by its owner. */
export function createEmptyInitialData(): SeedData {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), domains: [], categories: [], tags: [], questions: [], questionBanks: [], documents: [], papers: [] };
}
