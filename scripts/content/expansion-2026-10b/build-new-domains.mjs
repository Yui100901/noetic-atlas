/** Reproducible pending packages; deliberately does not open the user's database. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCatalogs, ROOT, STAMP } from './existing-builder.mjs';
import linguistics from './linguistics.mjs';
import music from './music.mjs';
import geography from './geography.mjs';
import economics from './economics.mjs';

export const catalogs=[linguistics,music,geography,economics];
const result=await buildCatalogs(catalogs);
await writeFile(join(ROOT,'data/content-sources/new-domains-20261026.json'),JSON.stringify({generatedAt:STAMP,...result},null,2)+'\n');
console.log(JSON.stringify({total:result.total,concepts:result.concepts,domains:result.reports.map(r=>({id:r.id,domainId:r.domainId,questions:r.questions,typeCounts:r.typeCounts})),skipped:result.skipped.length},null,2));
