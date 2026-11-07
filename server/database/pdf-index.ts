import { sql } from 'kysely';
import type { DatabaseConnection } from './connection.js';
import {
  normalizePdfText,
  pdfExcerpt,
  pdfSearchTokens,
  type PdfPage,
} from '../../shared/pdf/text.js';

/** SQLite FTS4 is shared by Node and SQL.js. All specialized SQL stays here. */
export class PdfTextIndex {
  constructor(private readonly db: DatabaseConnection) {}
  initialize() {
    const missing = !this.db.hasTable('pdf_page_fts');
    this.db.maintenance.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS pdf_page_fts USING fts4(id UNINDEXED, cache_id UNINDEXED, tokens, normalized UNINDEXED, page_number UNINDEXED, tokenize=unicode61);
    CREATE TRIGGER IF NOT EXISTS pdf_page_remove AFTER DELETE ON pdf_pages BEGIN DELETE FROM pdf_page_fts WHERE rowid=OLD.rowid; END;
    CREATE TRIGGER IF NOT EXISTS pdf_cache_remove AFTER DELETE ON pdf_caches BEGIN DELETE FROM pdf_pages WHERE json_extract(data,'$.cacheId')=OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS pdf_asset_remove AFTER DELETE ON assets BEGIN
      DELETE FROM pdf_jobs WHERE json_extract(data,'$.assetId')=OLD.id;
      DELETE FROM pdf_caches WHERE NOT EXISTS (SELECT 1 FROM pdf_jobs WHERE json_extract(pdf_jobs.data,'$.cacheId')=pdf_caches.id);
    END;
  `);
    if (missing) this.rebuild();
    return missing;
  }
  put(page: PdfPage) {
    const source = this.db.maintenance
      .prepare('SELECT rowid FROM pdf_pages WHERE id=?')
      .get(page.id) as { rowid: number } | undefined;
    if (!source) throw new Error('PDF page must be persisted before indexing');
    this.db.maintenance
      .prepare(
        'INSERT OR REPLACE INTO pdf_page_fts(rowid,id,cache_id,tokens,normalized,page_number) VALUES(?,?,?,?,?,?)',
      )
      .run(
        source.rowid,
        page.id,
        page.cacheId,
        pdfSearchTokens(page.text).join(' '),
        page.normalized,
        page.pageNumber,
      );
  }
  rebuild() {
    this.db.transaction(() => {
      this.db.maintenance.exec('DELETE FROM pdf_page_fts');
      for (const row of this.db.all(this.db.query.selectFrom('pdf_pages').select('data')))
        this.put(JSON.parse(row.data));
    });
  }
  private matches(query: string, cacheId?: string) {
    const tokens = pdfSearchTokens(query),
      terms = normalizePdfText(query).split(' ').filter(Boolean);
    if (!tokens.length) return;
    const expression = tokens
      .map(
        (token) =>
          '"' + token.replaceAll('"', '""') + (/^[a-z0-9_]+$/i.test(token) ? '*' : '') + '"',
      )
      .join(' AND ');
    // Keep verification/snippets in the compact projection. Positional source
    // JSON can be large and is read only by explicit cache maintenance.
    const verified = sql.join(
      terms.map((term) => sql`instr(f.normalized,${term})>0`),
      sql` AND `,
    );
    return sql`SELECT f.cache_id,f.normalized,f.page_number FROM pdf_page_fts f WHERE pdf_page_fts MATCH ${expression} AND ${verified}${cacheId ? sql` AND f.cache_id=${cacheId}` : sql``}`;
  }
  cacheIds(query: string): string[] {
    const matching = this.matches(query);
    if (!matching) return [];
    return this.db
      .all(
        sql<{ id: string }>`SELECT DISTINCT cache_id AS id FROM (${matching})`.compile(
          this.db.query,
        ),
      )
      .map((row) => row.id);
  }
  search(cacheId: string, query: string, offset = 0, limit = 20) {
    const matching = this.matches(query, cacheId);
    if (!matching) return { total: 0, hits: [] };
    const total = Number(
        this.db.one(
          sql<{ n: number }>`SELECT count(*) AS n FROM (${matching})`.compile(this.db.query),
        )?.n || 0,
      ),
      rows = this.db.all(
        sql<{
          normalized: string;
          page_number: number;
        }>`SELECT normalized,page_number FROM (${matching}) ORDER BY CAST(page_number AS INTEGER) LIMIT ${limit} OFFSET ${offset}`.compile(
          this.db.query,
        ),
      );
    return {
      total,
      hits: rows.map((row) => ({
        pageNumber: Number(row.page_number),
        excerpt: pdfExcerpt(row.normalized, query),
      })),
    };
  }
}
