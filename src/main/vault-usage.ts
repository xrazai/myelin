// Append-only learning events in `.myelin/usage.jsonl` (AGENTS.md, rule 1). Plain text,
// safe to sync. Runs inside vault-worker only. Every event is one JSON line, keyed by note
// path; a rename is an event so old lines never need rewriting.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type UsageEvent =
  | { type: 'renamed'; from: string; to: string; at: string }
  /** Reserved for the other event types of stage 3. */
  | { type: string; [key: string]: unknown };

/** Appends one event to the vault's usage log, creating `.myelin/` if needed. */
export async function appendUsageEvent(root: string, event: UsageEvent): Promise<void> {
  const folder = join(root, '.myelin');
  await mkdir(folder, { recursive: true });
  const line = JSON.stringify('at' in event ? event : { ...event, at: new Date().toISOString() });
  await appendFile(join(folder, 'usage.jsonl'), `${line}\n`, 'utf8');
}
