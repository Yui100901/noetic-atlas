import {buildTermPack} from './term-builder.mjs';
import {groups} from './terms-systems-catalog.mjs';

await buildTermPack({
  packId:'terms-systems',
  title:'计算机系统与软件工程术语概念',
  domainIds:['computer-science'],
  idPrefix:'TERM-SYS-',
  categoryPrefix:'term-sys',
  groups,
});
