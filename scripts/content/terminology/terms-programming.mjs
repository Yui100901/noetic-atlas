import { buildTermPack } from './term-builder.mjs';
import { groups } from './terms-programming-catalog.mjs';

await buildTermPack({
  packId: 'terms-programming',
  title: '计算机编程术语与概念',
  domainIds: ['computer-science'],
  idPrefix: 'TERM-PROG-',
  categoryPrefix: 'term-prog',
  groups,
});
