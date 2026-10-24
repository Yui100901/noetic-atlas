import test from 'node:test';
import assert from 'node:assert/strict';
import { learningSeed } from '../fixtures/learning-seed.js';
// @ts-expect-error: portable build helper is deliberately plain JavaScript.
import { validatePublicData } from '../../scripts/release/validate-public-data.mjs';
const publicData = () => learningSeed();
test('release data rejects private state objects, unreviewed questions and broken references', () => {
  const valid = publicData(); assert.equal(validatePublicData(valid).questions,valid.questions.length);
  for(const key of ['settings','ai_settings','study','paperDrafts']) { const value=publicData();value[key]={token:'opaque-non-provider-token'};assert.throws(()=>validatePublicData(value)); }
  const privateQuestion=publicData();privateQuestion.questions[0].collection='personal';assert.throws(()=>validatePublicData(privateQuestion));
  const pending=publicData();pending.questions[0].status='pending';assert.throws(()=>validatePublicData(pending));
  const dangling=publicData();dangling.questions[0].categoryIds.push('absent-source');assert.throws(()=>validatePublicData(dangling));
  const cycle=publicData();cycle.categories[0].parentId=cycle.categories[0].id;assert.throws(()=>validatePublicData(cycle));
});
