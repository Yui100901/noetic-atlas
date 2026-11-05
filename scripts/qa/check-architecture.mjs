/** Read-only first-party dependency scan; no service, database or AI calls. */
import { resolve } from 'node:path';
import { nativeAliases } from '../../mobile/vite-aliases.ts';
import {
  createDependencyIndex,
  inspectBoundaries,
  inspectNativeGraph,
} from '../testing/source-dependencies.mjs';

const root = resolve(import.meta.dirname, '../..');
const index = createDependencyIndex(root);
const boundaries = inspectBoundaries(index),
  native = inspectNativeGraph(index, nativeAliases);
console.log(
  JSON.stringify(
    {
      passed:
        !boundaries.unresolved.length && !boundaries.violations.length && !native.violations.length,
      ...boundaries,
      native,
    },
    null,
    2,
  ),
);
if (boundaries.unresolved.length || boundaries.violations.length || native.violations.length)
  process.exitCode = 1;
