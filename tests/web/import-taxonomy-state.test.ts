import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ImportTaxonomyCatalog,
  ImportTaxonomyMapping,
} from '../../shared/models/import-taxonomy.js';
import {
  changeImportMapping,
  importMappingIssue,
  importMappingTargets,
  mappedImportDomain,
} from '../../web/shared/lib/import-taxonomy-state.js';

const domain = (id: string, name: string) => ({ id, name, description: '', sortOrder: 0 });
const source: ImportTaxonomyCatalog = {
  domains: [domain('source-bio', '生物')],
  categories: [
    {
      id: 'source-cell',
      name: '细胞',
      description: '',
      sortOrder: 0,
      domainId: 'source-bio',
      parentId: null,
    },
  ],
  tags: [
    {
      id: 'source-tag',
      name: '入门',
      description: '',
      color: '#123456',
      domainId: 'source-bio',
      kind: 'topic',
    },
  ],
};
const local: ImportTaxonomyCatalog = {
  domains: [domain('biology', '生物学'), domain('computer', '计算机')],
  categories: [
    {
      id: 'cell',
      name: '细胞生物学',
      description: '',
      sortOrder: 0,
      domainId: 'biology',
      parentId: null,
    },
    {
      id: 'java',
      name: 'Java',
      description: '',
      sortOrder: 0,
      domainId: 'computer',
      parentId: null,
    },
  ],
  tags: [
    {
      id: 'bio-basic',
      name: '基础',
      description: '',
      color: '#123456',
      domainId: 'biology',
      kind: 'topic',
    },
    {
      id: 'java-basic',
      name: '基础',
      description: '',
      color: '#123456',
      domainId: 'computer',
      kind: 'topic',
    },
    {
      id: 'global',
      name: '概念',
      description: '',
      color: '#123456',
      domainId: null,
      kind: 'method',
    },
  ],
};

test('mapping never guesses that aliases are a shared domain, while exact local identity can remain unchanged', () => {
  assert.equal(mappedImportDomain('source-bio', source, local, {}), undefined);
  assert.equal(mappedImportDomain('biology', local, local, {}), 'biology');
  assert.equal(mappedImportDomain(null, source, local, {}), null);
});

test('mapping a domain scopes classification targets but keeps universal tags available', () => {
  const mapping: ImportTaxonomyMapping = {
    domains: [{ sourceId: 'source-bio', targetId: 'biology' }],
  };
  assert.deepEqual(
    importMappingTargets('categories', 'source-cell', source, local, mapping).map((row) => row.id),
    ['cell'],
  );
  assert.deepEqual(
    importMappingTargets('tags', 'source-tag', source, local, mapping).map((row) => row.id),
    ['bio-basic', 'global'],
  );
  const chosen = changeImportMapping(mapping, 'categories', 'source-cell', { targetId: 'cell' });
  assert.equal(importMappingIssue(source, local, chosen), '');
  assert.deepEqual(
    mapping,
    { domains: [{ sourceId: 'source-bio', targetId: 'biology' }] },
    'controlled choices do not mutate the previous preview input',
  );
});

test('changed domain choices invalidate incompatible child choices rather than silently deleting them', () => {
  const mapping: ImportTaxonomyMapping = {
    domains: [{ sourceId: 'source-bio', targetId: 'biology' }],
    categories: [{ sourceId: 'source-cell', targetId: 'cell' }],
  };
  const changed = changeImportMapping(mapping, 'domains', 'source-bio', { targetId: 'computer' });
  assert.match(importMappingIssue(source, local, changed), /细胞/);
  assert.deepEqual(changed.categories, mapping.categories);
});

test('incomplete selections and blank names must be completed before a new preview can be requested', () => {
  assert.match(
    importMappingIssue(source, local, { domains: [{ sourceId: 'source-bio', targetId: '' }] }),
    /有效/,
  );
  assert.match(
    importMappingIssue(source, local, { domains: [{ sourceId: 'source-bio', name: '  ' }] }),
    /新名称/,
  );
  assert.equal(
    importMappingIssue(source, local, {
      domains: [{ sourceId: 'source-bio', name: '现代生物学' }],
    }),
    '',
  );
  const cleared = changeImportMapping(
    { domains: [{ sourceId: 'source-bio', name: '现代生物学' }] },
    'domains',
    'source-bio',
  );
  assert.deepEqual(cleared.domains, []);
});
