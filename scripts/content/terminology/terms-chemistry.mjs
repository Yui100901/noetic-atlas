import {buildTermPack} from './term-builder.mjs';
import {groups} from './terms-chemistry-catalog.mjs';

await buildTermPack({packId:'terms-chemistry',title:'化学结构、反应与分析术语',domainIds:['chemistry'],idPrefix:'TERM-CHEM-',categoryPrefix:'term-chem',groups});
