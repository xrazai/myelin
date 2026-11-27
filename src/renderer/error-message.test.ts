import { expect, test } from 'vitest';
import { errorMessage } from './error-message';

test('strips the wrapper Electron adds to a rejected call', () => {
  const error = new Error("Error invoking remote method 'vault:open': Error: .myelin/vault.json is not valid JSON.");
  expect(errorMessage(error)).toBe('.myelin/vault.json is not valid JSON.');
});

test('keeps any other message', () => {
  expect(errorMessage(new Error('EACCES: permission denied'))).toBe('EACCES: permission denied');
  expect(errorMessage('plain')).toBe('plain');
});
