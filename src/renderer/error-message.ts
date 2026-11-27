// A rejected `window.myelin` call arrives wrapped by Electron:
// "Error invoking remote method 'vault:open': Error: <message>".
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '');
}
