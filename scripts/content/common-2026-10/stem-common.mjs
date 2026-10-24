import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeCommonPack } from './common-builder.mjs';
import { geographyCommon } from './geography-common.mjs';
import { physicsCommon } from './physics-common.mjs';
import { chemistryCommon } from './chemistry-common.mjs';
import { medicineCommon } from './medicine-common.mjs';
export const stemCommonCatalogs=[geographyCommon,physicsCommon,chemistryCommon,medicineCommon];
export async function buildStemCommon(){
  const results=[];
  for(const catalog of stemCommonCatalogs){
    const count=catalog.groups.reduce((sum,group)=>sum+group.questions.length,0);
    const expected=['geography','physics'].includes(catalog.domainId)?80:60;
    if(count!==expected)throw new Error(catalog.id+': expected '+expected+', got '+count);
    const report=await writeCommonPack(catalog);results.push({id:report.id,questions:report.questions,typeCounts:report.typeCounts,sha256:report.sha256});
  }
  return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify(await buildStemCommon(),null,2));
