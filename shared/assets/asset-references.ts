import { assetIdFromUrl } from './assets.js';

/** Managed file references include nested material, frozen snapshots and notes.
 * Embedded binary payloads are never interpreted as links. */
export function collectAssetReferences(value: unknown, found = new Set<string>()): Set<string> {
  // Consume a complete URL token before validating it. Matching just a local
  // path substring would accept remote URLs and /content-invalid suffixes.
  if (typeof value === 'string') {
    // Scan each complete token before inspecting schemes. The former
    // compound regexp exhausted V8's stack on long ordinary text and payloads.
    for (const token of value.matchAll(/[^\s"'()<>\]]+/g)) {
      if (!token[0].includes('/api/assets/')) continue;
      const match = /(?<![\p{L}\p{N}_.:%\/-])\/api\/assets\//u.exec(token[0]);
      if (!match) continue;
      const prefix = token[0].slice(0, match.index);
      let remote = prefix.includes('//');
      let schemeHasLetter = false;
      for (const character of prefix) {
        if (character === ':' && schemeHasLetter) { remote = true; break; }
        if (/[A-Za-z]/.test(character)) schemeHasLetter = true;
        else if (!/[0-9+.-]/.test(character)) schemeHasLetter = false;
      }
      if (remote) continue;
      const aid = assetIdFromUrl(token[0].slice(match.index));
      if (aid) found.add(aid);
    }
  }
  else if (Array.isArray(value)) for (const entry of value) collectAssetReferences(entry, found);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { if (key === 'assetId' && typeof entry === 'string' && entry) found.add(entry); else if (key !== 'dataBase64') collectAssetReferences(entry, found); }
  return found;
}
