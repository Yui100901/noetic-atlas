import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getNativeRuntimeBundle } from '../../scripts/testing/native-runtime-bundle.mjs';

type NativeRuntimeModule = Pick<typeof import('../../mobile/runtime.ts'), 'createLocalRuntime'>;

/** Only compiled code is shared. Each call imports a fresh module namespace so
 * the native SQLite/fs shim globals cannot leak across independent test cases.
 * The caller still creates and closes its own runtime, SQL module and storage. */
export async function loadNativeRuntime(): Promise<NativeRuntimeModule> {
  const bundle = pathToFileURL(await getNativeRuntimeBundle());
  bundle.searchParams.set('test-instance', randomUUID());
  return import(bundle.href) as Promise<NativeRuntimeModule>;
}
