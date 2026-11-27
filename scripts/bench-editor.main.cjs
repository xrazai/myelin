// Electron main process of `bench-editor.ts`: opens the page and types into it with real
// key events through the DevTools protocol. Prints one JSON line.
//   electron scripts/bench-editor.main.cjs <page.html> <userData> <keys> <cases as JSON>
const { app, BrowserWindow } = require('electron');

const [page, userData, keys, cases] = process.argv.slice(2);
app.setPath('userData', userData);
// A covered or unfocused window must not be throttled.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/** Typed over and over: prose, the syntax live preview reacts to, and new lines. */
const TEXT = 'The **synapse** links _two_ ideas, see [[Home|the home note]] and `code`.\n';

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(page);
    const run = (code) => window.webContents.executeJavaScript(code);
    window.webContents.debugger.attach('1.3');
    const send = (params) => window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', params);
    const results = [];
    for (const { name, lines, line } of JSON.parse(cases)) {
      const check = await run(`bench.open(${lines}, ${line})`);
      const before = await run('bench.length()');
      const samples = [];
      for (let i = 0; i < Number(keys); i++) {
        const char = TEXT[i % TEXT.length];
        const key =
          char === '\n'
            ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }
            : { key: char, text: char };
        // Two channels reach the page: it must be waiting before the key is sent.
        await run('bench.arm()');
        const sample = run('bench.sample()');
        await send({ type: 'keyDown', ...key });
        let timer;
        samples.push(
          await Promise.race([
            sample,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`key ${i} of "${name}" changed no text`)), 5000);
            }),
          ]),
        );
        clearTimeout(timer);
        await send({ type: 'keyUp', key: key.key });
      }
      results.push({ name, ...check, typed: (await run('bench.length()')) - before, samples });
    }
    process.stdout.write(`BENCH ${JSON.stringify({ chrome: process.versions.chrome, results })}\n`, () => app.exit(0));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`, () => app.exit(1));
  }
});
