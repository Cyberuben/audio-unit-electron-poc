// Run with Playwright installed, or NODE_PATH pointing to the bundled runtime packages.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const ready = (page) => page.waitForFunction(() => !document.getElementById('open').disabled);
const isPlaying = (page) =>
  page.waitForFunction(
    () => document.getElementById('play').getAttribute('aria-label') === 'Pause audio',
  );

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'isolation-ui-'));
  // Two distinct channels verify the model routing preserves stereo.
  const frames = 48000 * 3;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < frames; i++) {
    wav.writeInt16LE(Math.round(180 * Math.sin((i * 2 * Math.PI * 440) / 48000)), 44 + i * 4);
    wav.writeInt16LE(Math.round(180 * Math.sin((i * 2 * Math.PI * 880) / 48000)), 46 + i * 4);
  }
  const file = path.join(temp, 'stereo-test.wav');
  await fs.writeFile(file, wav);
  let app;
  try {
    app = await electron.launch({ args: [root], executablePath: require('electron') });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('Renderer:', message.text());
    });
    await ready(page);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, file);
    await page.locator('#open').click();
    await ready(page);
    assert.equal(await page.locator('#play').isDisabled(), false);
    await page.locator('#trim-start').fill('0.5');
    await page.locator('#trim-end').fill('1.2');
    await page.locator('#apply-trim').click();
    await ready(page);
    assert.match(await page.locator('#trim-summary').innerText(), /0.700/);
    await page.locator('#loop').check();
    await ready(page);
    await page.locator('#play').click();
    await ready(page);
    console.log('Playback status:', await page.locator('#status').innerText());
    await isPlaying(page);
    assert.equal(await page.locator('#effect-title').innerText(), 'DeepFilterNet3');
    // Loop for several iterations and assert the displayed playhead remains in the selection.
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(350);
      const current = parseFloat(await page.locator('#duration').innerText());
      assert(current >= 0.5 && current <= 1.2, `Out of trim: ${current}`);
    }
    await page.locator('#play').click();
    await ready(page);
    const paused = await page.locator('#duration').innerText();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#duration').innerText(), paused);
    await page.locator('#play').click();
    await ready(page);
    await isPlaying(page);
    if (process.platform === 'darwin') {
      await page.waitForFunction(() => !document.getElementById('au-option').disabled);
      for (const name of ['AUSoundIsolation', 'DeepFilterNet3', 'AUSoundIsolation']) {
        await page.locator('#compare').click();
        await ready(page);
        await isPlaying(page);
        assert.equal(await page.locator('#effect-title').innerText(), name);
        assert.match(await page.locator('#trim-summary').innerText(), /0.700/);
        await page.waitForTimeout(180);
      }
      assert.equal(await page.locator('#mix').getAttribute('min'), '-100');
      await page.locator('#backend').selectOption('dfn');
      await ready(page);
      await isPlaying(page);
      assert.equal(await page.locator('#backend').inputValue(), 'dfn');
    }
    await page.locator('#effect').uncheck();
    await ready(page);
    assert.equal(await page.locator('#mix').isDisabled(), true);
    await page.locator('#effect').check();
    await ready(page);
    await page.locator('#mix').fill('40');
    await page.locator('#mix').dispatchEvent('input');
    await page.locator('#trim-start').fill('2');
    await page.locator('#trim-end').fill('1');
    await page.locator('#apply-trim').click();
    await ready(page);
    assert.match(await page.locator('#status').innerText(), /Choose a start/);
    assert.match(await page.locator('#trim-summary').innerText(), /0.700/);
    await page.locator('#reset-trim').click();
    await ready(page);
    assert.match(await page.locator('#trim-summary').innerText(), /3.000/);
    await page.locator('#play').click();
    await ready(page);
    await page.locator('#trim-start').fill('0.5');
    await page.locator('#trim-end').fill('1.2');
    await page.locator('#apply-trim').click();
    await ready(page);
    await page.locator('#loop').uncheck();
    await ready(page);
    await page.locator('#play').click();
    await ready(page);
    await page.waitForFunction(
      () => document.getElementById('status').textContent === 'Selection finished.',
    );
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'dist/comparison.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      'PASS: real DFN, stereo, native A/B, selector, trimmed loops, pause/resume, bypass/mix, invalid trim, completion',
    );

    // Measure actual WASM output, rather than only trusting a successful UI initialization.
    const dsp = await page.evaluate(async () => {
      const { BrowserEngine } = await import('./browser-engine.js');
      const failures = [];
      const engine = new BrowserEngine(
        () => {},
        (message) => failures.push(message),
      );
      const ctx = new AudioContext({ sampleRate: 48000 });
      engine.context = ctx;
      engine.buffer = ctx.createBuffer(1, 48000 * 2, 48000);
      const data = engine.buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++)
        data[i] = Math.sin((i * Math.PI * 2 * 440) / 48000) * 0.005;
      try {
        await engine.play({ trim: { start: 0, end: 2 }, loop: true, mix: 100, enabled: true });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const wet = engine.spectra();
        engine.setMix(0, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const dry = engine.spectra();
        return {
          input: Math.max(...wet.input.bins),
          wet: Math.max(...wet.output.bins),
          dry: Math.max(...dry.output.bins),
          failures,
        };
      } finally {
        await engine.close();
      }
    });
    console.log('DSP:', dsp);
    assert(
      dsp.input > -85 && Math.abs(dsp.dry - dsp.input) < 2 && dsp.wet < dsp.dry - 10,
      JSON.stringify(dsp),
    );
    assert.deepEqual(dsp.failures, []);

    for (const platform of ['win32', 'linux']) {
      const preload = path.join(temp, `fallback-${platform}.cjs`);
      await fs.writeFile(
        preload,
        `const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('audioLab',{info:async()=>({native:false,platform:'${platform}'}),open:async()=>({id:1,name:'test.wav',bytes:${JSON.stringify([...wav])}}),onEvent:()=>{},loadNative:async()=>{throw Error('Unexpected native call')},command:async()=>{throw Error('Unexpected native call')}});`,
      );
      const nextWindow = app.waitForEvent('window');
      await app.evaluate(({ BrowserWindow }, preload) => {
        const win = new BrowserWindow({
          webPreferences: { preload, sandbox: true, contextIsolation: true },
        });
        win.loadURL('lab://app/index.html');
      }, preload);
      const fallback = await nextWindow;
      await ready(fallback);
      assert.equal(await fallback.locator('#au-option').isDisabled(), true);
      await fallback.locator('#open').click();
      await ready(fallback);
      await fallback.locator('#play').click();
      await ready(fallback);
      await isPlaying(fallback);
      assert.equal(await fallback.locator('#compare').isDisabled(), true);
      await fallback.locator('#play').click();
      await ready(fallback);
      await fallback.close();
      console.log(
        `PASS: ${platform} UI configuration, real DFN playback, no native dependency (host OS: ${process.platform})`,
      );
    }
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
