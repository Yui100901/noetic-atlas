import { writeCommonPack } from './common-builder.mjs';
import { buildComputerCommon } from './computer-common.mjs';
import { english } from './language-english.mjs';
import { japanese } from './language-japanese.mjs';
import { chinese } from './language-chinese.mjs';
import { driving } from './driving-common.mjs';
import { buildStemCommon } from './stem-common.mjs';
import { buildPsychologyCommon } from './psychology-common.mjs';
import { buildEconomicsCommon } from './economics-common.mjs';

const results = [await buildComputerCommon()];
for (const catalog of [english, japanese, chinese, driving]) results.push(await writeCommonPack(catalog));
results.push(...await buildStemCommon(), await buildPsychologyCommon(), await buildEconomicsCommon());
console.log(JSON.stringify({ questions: results.reduce((sum, result) => sum + result.questions, 0), packs: results.map(({ id, questions, typeCounts }) => ({ id, questions, typeCounts })) }, null, 2));
