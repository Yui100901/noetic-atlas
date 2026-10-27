import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptPromptIsSafe } from '../../shared/questions/concept.js';
import { conceptSchema } from '../../server/core/validation.js';

async function catalogs() {
  const base = '../../scripts/content/concepts-2026-10/';
  const modules = await Promise.all(['computer', 'economics', 'psychology', 'geography', 'physics', 'chemistry', 'language-driving'].map(name => import(base + name + '.mjs')));
  return modules.flatMap(module => Array.isArray(module.default) ? module.default : [module.default]);
}

test('concept catalogs cover ten domains with distinct named concepts, independent prompts and useful distinctions', async () => {
  const items = await catalogs(), seen = new Set<string>(); let total = 0;
  assert.equal(new Set(items.map(catalog => catalog.domainId)).size, 10);
  for (const catalog of items) for (const row of catalog.rows) {
    total++; const identity = catalog.domainId + ':' + row.term.normalize('NFKC').toLowerCase();
    assert.ok(!seen.has(identity), 'Duplicate authored concept: ' + identity); seen.add(identity);
    assert.ok(catalog.groups[row.group]); assert.ok(row.distinction.length >= 15, row.term + ': missing substantive distinction');
    const concept = { term: row.term, meaningPrompt: row.meaningPrompt, acceptedAnswers: [row.term, ...row.aliases] };
    assert.equal(conceptPromptIsSafe(concept), true, row.term + ': answer leaks into prompt'); conceptSchema.parse(concept);
    assert.ok(!/[？?]/.test(row.term), 'A scenario question must not become a concept title');
  }
  assert.ok(total >= 500, 'Retain at least 500 independently authored input concepts before existing-title deduplication');
  assert.ok(items.find(catalog => catalog.domainId === 'computer-science').rows.length >= 100);
});

test('existing economic and psychological cards use separately authored definitions rather than reversing their scenario answers', async () => {
  const { existingPrompts } = await import('../../scripts/content/concepts-2026-10/existing-prompts.mjs');
  assert.match(existingPrompts.economics['沉没成本'], /已经发生.*无法收回/);
  assert.match(existingPrompts.psychology['负强化'], /移除或避免.*提高/);
  assert.ok(Object.keys(existingPrompts.economics).length >= 30); assert.ok(Object.keys(existingPrompts.psychology).length >= 30);
  for (const entries of Object.values(existingPrompts)) for (const [term, meaningPrompt] of Object.entries(entries as Record<string, string>)) {
    assert.equal(conceptPromptIsSafe({ term, meaningPrompt, acceptedAnswers: [term] }), true, term);
    assert.ok(!/^(不是|可以|不能|例如|关注)/.test(meaningPrompt), term + ': contextual response is not an independent definition');
  }
});

test('catalog references use direct primary sources for high-risk implementation distinctions and causal identification', async () => {
  const { sources } = await import('../../scripts/content/concepts-2026-10/builder.mjs');
  for (const [key, [, url]] of Object.entries(sources) as Array<[string, [string, string]]>) {
    const parsed = new URL(url); assert.equal(parsed.protocol, 'https:', key); assert.equal(parsed.username, ''); assert.equal(parsed.password, '');
  }
  assert.match(sources.pgwal[1], /postgresql\.org.*wal-intro/); assert.match(sources.queue[1], /rabbitmq\.com.*dlx/);
  assert.match(sources.causal[1], /worldbank\.org/); assert.match(sources.game[1], /ocw\.mit\.edu/);
});
