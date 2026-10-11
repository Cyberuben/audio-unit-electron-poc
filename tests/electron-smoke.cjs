// Run with Playwright installed, or NODE_PATH pointing to the bundled runtime packages.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'isolation-ui-'));
  const wav = Buffer.alloc(44 + 48000 * 2 * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 96000; i++)
    wav.writeInt16LE(Math.round(180 * Math.sin((i * 2 * Math.PI * 440) / 48000)), 44 + i * 2);
  const file = path.join(temp, 'test-tone.wav');
  await fs.writeFile(file, wav);
  let app;
  try {
    app = await electron.launch({
      args: [path.join(__dirname, '..')],
      executablePath: require('electron'),
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForFunction(() => !document.getElementById('open').disabled);
    assert.equal(await page.locator('#mix').getAttribute('min'), '-100');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.locator('#open').click();
    await page.waitForFunction(() => !document.getElementById('play').disabled);
    await page.locator('#loop').check();
    await page.locator('#play').click();
    await page.waitForFunction(
      () => document.getElementById('play').getAttribute('aria-label') === 'Pause audio',
    );
    await page.waitForFunction(
      () => spectra.input && spectra.output && Math.max(...spectra.input.bins) > -70,
    );
    await page.locator('#mix').fill('0');
    await page.locator('#mix').dispatchEvent('input');
    await page.locator('#effect').uncheck();
    assert.equal(await page.locator('#mix').isDisabled(), true);
    await page.locator('#effect').check();
    await fs.mkdir(path.join(__dirname, '../dist'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '../dist/screenshot.png') });
    await page.locator('#play').click();
    await page.waitForFunction(
      () => document.getElementById('play').getAttribute('aria-label') === 'Play audio',
    );
    await page.locator('#restart').click();
    assert.deepEqual(errors, []);
    console.log(
      'PASS: Electron bridge, file picker, native playback, spectra, pause, loop, bypass, mix, screenshot',
    );
    // Exercise the Windows renderer backend in a second window on this Mac.
    const preload = path.join(temp, 'fallback.cjs');
    await fs.writeFile(
      preload,
      `const {contextBridge}=require('electron'); contextBridge.exposeInMainWorld('audioLab',{info:async()=>({native:false,platform:'win32'}),open:async()=>({native:false,name:'test-tone.wav',bytes:${JSON.stringify([...wav])}}),onEvent:()=>{},command:async()=>{throw new Error('Unexpected native call')}});`,
    );
    const nextWindow = app.waitForEvent('window');
    await app.evaluate(
      ({ BrowserWindow }, { preload, html }) => {
        const win = new BrowserWindow({
          webPreferences: { preload, sandbox: true, contextIsolation: true },
        });
        win.loadFile(html);
      },
      { preload, html: path.join(__dirname, '../src/index.html') },
    );
    const fallback = await nextWindow;
    await fallback.waitForFunction(() => !document.getElementById('open').disabled);
    assert.equal(await fallback.locator('#effect').isDisabled(), true);
    await fallback.locator('#open').click();
    await fallback.waitForFunction(() => !document.getElementById('play').disabled);
    await fallback.locator('#loop').check();
    await fallback.locator('#play').click();
    await fallback.waitForFunction(() => spectra.input && Math.max(...spectra.input.bins) > -70);
    await fallback.locator('#play').click();
    await fallback.locator('#restart').click();
    console.log(
      'PASS: Windows Web Audio renderer fallback (exercised on macOS, not a Windows OS test)',
    );
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
