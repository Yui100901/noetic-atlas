/** Run with: node --import tsx scripts/content/concepts-2026-10/build.mjs */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import computer from './computer.mjs';
import economics from './economics.mjs';
import psychology from './psychology.mjs';
import geography from './geography.mjs';
import physics from './physics.mjs';
import chemistry from './chemistry.mjs';
import languages from './language-driving.mjs';
import { buildConceptPacks, planExistingConcepts, ROOT, STAMP } from './builder.mjs';

const catalogs = [computer, economics, psychology, geography, physics, chemistry, ...languages];
const result = await buildConceptPacks(catalogs), metadata = await planExistingConcepts();
const report = { generatedAt: STAMP, newQuestions: result.questions, byDomain: Object.fromEntries(result.reports.map(row => [row.domainId, row.questions])), newPackNames: result.reports.map(row => row.id), inputConcepts: catalogs.reduce((sum, row) => sum + row.rows.length, 0), existingSameNameSkipped: result.skipped, metadata, reviewStatus: 'pending', realDatabaseOpened: false };
await mkdir(join(ROOT, 'data/content-sources'), { recursive: true });
await writeFile(join(ROOT, 'data/content-sources/concepts-expansion-20261026.json'), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({ newQuestions: report.newQuestions, byDomain: report.byDomain, inputConcepts: report.inputConcepts, sameNameSkipped: result.skipped.length, metadata }, null, 2));
