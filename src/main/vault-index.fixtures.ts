// Test support only.
import { readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Overwrites the root page of the `links` table of a closed index. The file still opens:
 * SQLite reports the damage only when it reaches that page.
 */
export function damageLinks(file: string): void {
  const db = new Database(file);
  const size = db.pragma('page_size', { simple: true }) as number;
  const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'links'").pluck().get() as number;
  db.close();
  const bytes = readFileSync(file);
  bytes.fill(0xab, (root - 1) * size, root * size);
  writeFileSync(file, bytes);
}
