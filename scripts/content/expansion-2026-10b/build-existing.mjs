/** Repeatable authoring package build; no working database writes. */
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {buildCatalogs,ROOT,STAMP} from './existing-builder.mjs';
import medicine from './medicine-catalog.mjs';
import computer from './existing-computer.mjs';
import physics from './existing-physics.mjs';
import chemistry from './existing-chemistry.mjs';
import psychology from './existing-psychology.mjs';
import chinese from './existing-chinese.mjs';
import english from './existing-english.mjs';
import japanese from './existing-japanese.mjs';
import driving from './existing-driving.mjs';
const result=await buildCatalogs([medicine,computer,physics,chemistry,psychology,chinese,english,japanese,driving]);
await writeFile(join(ROOT,'data/content-sources/existing-domains-20261026.json'),JSON.stringify({generatedAt:STAMP,...result},null,2)+'\n');
console.log(JSON.stringify({total:result.total,concepts:result.concepts,domains:result.reports.map(r=>({id:r.id,domainId:r.domainId,questions:r.questions,typeCounts:r.typeCounts})),skipped:result.skipped.length},null,2));
