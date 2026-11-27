// Electron main process of `bench-graph.ts`: runs the page in a hidden window, one graph at
// a time, and prints one JSON line.
//   electron scripts/bench-graph.main.cjs <page.html> <userData> <job.json>
const { app, BrowserWindow } = require('electron');
const { readFileSync } = require('node:fs');

const [page, userData, jobFile] = process.argv.slice(2);
app.setPath('userData', userData);
// On a machine with two GPUs, the strong one: the budget is stated for it.
app.commandLine.appendSwitch('force_high_performance_gpu');
// A hidden window must not be throttled.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function fail(error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`, () => app.exit(1));
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  const messages = [];
  window.webContents.on('console-message', (event) => messages.push(event.message));
  try {
    await window.loadFile(page);
    const run = (code) => window.webContents.executeJavaScript(code);
    const { graphs, ...config } = JSON.parse(readFileSync(jobFile, 'utf8'));
    const info = await run('bench.info()');
    const results = [];
    for (const { nodeCount, files } of graphs) {
      const data = Object.fromEntries(
        Object.entries(files).map(([name, file]) => [name, readFileSync(file).toString('base64')]),
      );
      process.stderr.write(`drawing ${nodeCount} nodes\n`);
      results.push({ nodeCount, ...(await run(`bench.run(${JSON.stringify({ ...config, ...data, nodeCount })})`)) });
    }
    process.stdout.write(`BENCH ${JSON.stringify({ chrome: process.versions.chrome, ...info, results })}\n`, () =>
      app.exit(0),
    );
  } catch (error) {
    fail(`${error && error.stack ? error.stack : error}\n${messages.join('\n')}`);
  }
}).catch(fail);
