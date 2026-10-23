import { assetIdFromUrl } from './assets.js';

/** Managed file references include nested material, frozen snapshots and notes.
 * Embedded binary payloads are never interpreted as links. */
export function collectAssetReferences(value: unknown, found = new Set<string>()): Set<string> {
  // Consume a complete URL token before validating it. Matching just a local
  // path substring would accept remote URLs and /content-invalid suffixes.
  if (typeof value === 'string') for (const match of value.matchAll(/(?:[A-Za-z][A-Za-z0-9+.-]*:(?:\/\/)?|\/\/|(?<![\p{L}\p{N}_.:%\/-])\/api\/assets\/)[^\s"'()<>\]]+/gu)) { const aid = assetIdFromUrl(match[0]); if (aid) found.add(aid); }
  else if (Array.isArray(value)) for (const entry of value) collectAssetReferences(entry, found);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { if (key === 'assetId' && typeof entry === 'string' && entry) found.add(entry); else if (key !== 'dataBase64') collectAssetReferences(entry, found); }
  return found;
}
