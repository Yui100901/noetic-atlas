import {buildTermPack} from './term-builder.mjs';
import {groups} from './terms-medicine-clinical-catalog.mjs';

await buildTermPack({
  packId:'terms-medicine-clinical',
  title:'医学检验、影像与临床研究术语',
  domainIds:['medicine-pharmacy'],
  idPrefix:'TERM-MEDCL-',
  categoryPrefix:'term-medcl',
  groups,
});
