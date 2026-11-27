// Owner of all vault file I/O, the watcher, parsing and SQLite (CLAUDE.md, rule 1).
import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';

export type WorkerMessage = { type: 'ready'; sqliteVersion: string };

// Startup check: the native module loads in this thread and its SQLite has FTS5.
function checkSqlite(): string {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');
    return db.prepare('SELECT sqlite_version()').pluck().get() as string;
  } finally {
    db.close();
  }
}

parentPort?.postMessage({ type: 'ready', sqliteVersion: checkSqlite() } satisfies WorkerMessage);
