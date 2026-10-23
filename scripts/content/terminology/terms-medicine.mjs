import {buildTermPack} from './term-builder.mjs';
import {groups} from './terms-medicine-catalog.mjs';
if(groups.length!==2||groups.some(g=>g.rows.length!==20))throw Error('Expected twenty physiology and twenty pathology terms');
await buildTermPack({packId:'terms-medicine',title:'医学基础生理、病理与症状术语',domainIds:['medicine-pharmacy'],idPrefix:'TERM-MED-',categoryPrefix:'term-med',groups});
