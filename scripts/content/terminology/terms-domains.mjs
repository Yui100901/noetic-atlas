import {buildTermPack} from './term-builder.mjs';
import {groups} from './terms-domains-catalog.mjs';

if(groups.length!==6||groups.some(group=>group.rows.length!==20))throw Error('Expected six domains with twenty distinct concept cards each');
await buildTermPack({
 packId:'terms-domains',
 title:'六领域术语与概念：语言、化学、药学与驾驶',
 domainIds:['english','japanese','chinese','chemistry','medicine-pharmacy','driving'],
 idPrefix:'TERM-DOM-',
 categoryPrefix:'term-dom',
 groups,
});
