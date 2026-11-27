import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const read = (path: string) => readFileSync(join(import.meta.dirname, '..', path), 'utf8');

test('styles.css declares every palette token of docs/identity.md with the same value', () => {
  const styles = read('src/renderer/styles.css');
  const tokens = [...read('docs/identity.md').matchAll(/^\| `([a-z-]+)` \| `(#[0-9A-Fa-f]{6})` \|/gm)];
  expect(tokens.length).toBeGreaterThanOrEqual(7);
  for (const [, name, hex] of tokens) {
    expect(styles).toContain(`--${name}: ${hex!.toLowerCase()};`);
  }
});
