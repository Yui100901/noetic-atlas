import test from 'node:test';
import assert from 'node:assert/strict';
import { rubricRoot, selectedRubrics } from '../../web/features/papers/rubric-overrides.js';

test('rubric overrides retain exact and grouped identities without splitting valid root IDs', () => {
  const roots = ['ordinary', 'group', 'root::with::separator'];
  const overrides = {
    ordinary: 'base',
    'group::part': 'leaf',
    'root::with::separator': 'named root',
    'root::with::separator::part': 'named child',
    'other::part': 'removed',
  };
  assert.deepEqual(selectedRubrics(overrides, roots), {
    ordinary: 'base',
    'group::part': 'leaf',
    'root::with::separator': 'named root',
    'root::with::separator::part': 'named child',
  });
  assert.equal(rubricRoot('root::with::separator', roots), 'root::with::separator');
  assert.equal(rubricRoot('::unselected', roots), undefined);
  assert.equal(
    rubricRoot('root::with::separator::part', ['root', ...roots]),
    'root::with::separator',
  );
});

test('a blank override is preserved while deselected roots and all their parts are removed', () => {
  assert.deepEqual(selectedRubrics({ Q: '', 'G::first': 'strict', 'G::second': '' }, ['Q']), {
    Q: '',
  });
  assert.deepEqual(selectedRubrics({ Q: '', 'G::first': 'strict' }, []), {});
});
