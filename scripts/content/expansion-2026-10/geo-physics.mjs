import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { saveFoundationPack } from './geo-physics-builder.mjs';
import { geography } from './geography-catalog.mjs';
import { physics } from './physics-catalog.mjs';

export async function buildGeographyPhysics() {
  const output = [];
  for (const catalog of [geography, physics]) {
    const manifest = await saveFoundationPack(catalog);
    if (manifest.questions !== 120) throw new Error(`${manifest.id}: expected 120, got ${manifest.questions}`);
    output.push({ id: manifest.id, questions: manifest.questions, typeCounts: manifest.typeCounts, sha256: manifest.sha256 });
  }
  return output;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) console.log(JSON.stringify(await buildGeographyPhysics(), null, 2));
