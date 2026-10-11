import { BrowserEngine } from './browser-engine.js';
import { drawSpectrum } from './spectrum.js';

const $ = (id) => document.getElementById(id);
const names = { dfn: 'DeepFilterNet3', au: 'AUSoundIsolation' };
let backend = 'dfn';
let auAvailable = false;
let auMix = { min: -100, max: 100 };
let clip = null;
let nativeFileId = null;
let playing = false;
let busy = false;
let enabled = true;
let loop = false;
let trim = { start: 0, end: 0 };
let nativePosition = 0;
let nativeStartedAt = 0;
let nativeEnded = false;
let spectra = {};
const mixes = { dfn: 100, au: 100 };
const browser = new BrowserEngine(
  () => {
    if (backend === 'dfn') {
      setPlaying(false);
      showStatus('Selection finished.');
    }
  },
  (message) => {
    if (backend === 'dfn') {
      if (!browser.playing) setPlaying(false);
      showStatus(message, true);
    }
  },
);

function showStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function setPlaying(value) {
  playing = value;
  $('play').textContent = value ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', value ? 'Pause audio' : 'Play audio');
}
function updateControls() {
  for (const id of [
    'play',
    'restart',
    'loop',
    'trim-start',
    'trim-end',
    'apply-trim',
    'reset-trim',
  ]) {
    $(id).disabled = busy || !clip;
  }
  $('open').disabled = busy;
  $('backend').disabled = busy;
  $('au-option').disabled = !auAvailable;
  $('compare').disabled = busy || !clip || !auAvailable;
  $('effect').disabled = busy;
  $('mix').disabled = busy || !enabled;
  $('backend').value = backend;
  $('effect-title').textContent = names[backend];
  $('effect-kind').textContent = backend === 'au' ? 'NATIVE AUDIO UNIT' : 'LOCAL WEBASSEMBLY';
  $('compare').textContent = `↔ Switch to ${names[backend === 'au' ? 'dfn' : 'au']} & replay`;
  $('comparison-note').textContent = auAvailable
    ? 'Switch & replay starts the same selection with the other effect.'
    : 'DeepFilterNet3 works on every platform. AUSoundIsolation requires a supported Mac.';
  $('effect-description').textContent =
    backend === 'au'
      ? 'Apple’s native voice isolation. Its signed mix setting is remembered separately.'
      : '48 kHz denoising · stereo preserved · extra pause gate and automatic gain disabled.';
  $('mix').min = backend === 'au' ? auMix.min : 0;
  $('mix').max = backend === 'au' ? auMix.max : 100;
  $('mix').value = mixes[backend];
  $('mix-value').textContent = `${mixes[backend]}%`;
  $('mix-min').textContent = backend === 'au' ? `${auMix.min}%` : '0% · Original';
  $('mix-max').textContent = '100% · Processed';
  $('effect-label').textContent = enabled ? 'Effect on' : 'Bypassed';
  $('effect').checked = enabled;
}
// Serialize user operations. Native commands resolve only after the helper acknowledges them.
function action(fn) {
  return async () => {
    if (busy) return;
    busy = true;
    updateControls();
    try {
      await fn();
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  };
}
const native = (command, value) => window.audioLab.command({ command, value });

async function pause() {
  if (backend === 'au' && nativeFileId !== null) {
    nativePosition = position();
    await native('pause');
  } else if (backend === 'dfn') await browser.pause();
  setPlaying(false);
}
async function prepareNative() {
  if (!auAvailable) throw new Error('AUSoundIsolation is unavailable. Select DeepFilterNet3.');
  if (nativeFileId !== clip.id) {
    await window.audioLab.loadNative(clip.id);
    nativeFileId = clip.id;
    await window.audioLab.command({ command: 'trim', ...trim });
    nativePosition = trim.start;
    nativeEnded = false;
  }
  await native('loop', loop);
  await native('mix', mixes.au);
  await native('bypass', !enabled);
}
async function play(restart = false) {
  if (!clip) return;
  if (backend === 'dfn') {
    if (!browser.ready) showStatus('Loading the local DeepFilterNet3 model…');
    await browser.play({ trim, loop, mix: mixes.dfn, enabled, restart });
  } else {
    await prepareNative();
    if (restart || nativeEnded) {
      await native('restart');
      nativePosition = trim.start;
      nativeEnded = false;
    }
    await native('play');
    nativeStartedAt = performance.now();
  }
  setPlaying(true);
  showStatus(`Playing selection through ${names[backend]}.`);
}
async function switchBackend(next, replay) {
  const resume = playing || replay;
  await pause(); // Stop the old engine before enabling the other output.
  backend = next;
  spectra = {};
  nativePosition = trim.start;
  browser.offset = trim.start;
  updateControls();
  if (clip && resume) await play(true);
  else showStatus(`${names[backend]} selected.`);
}
function position() {
  if (backend === 'dfn') return browser.position();
  if (!playing) return nativePosition;
  const current = nativePosition + (performance.now() - nativeStartedAt) / 1000;
  return Math.min(trim.end, current);
}
function displayTrim() {
  $('trim-start').value = trim.start.toFixed(3);
  $('trim-end').value = trim.end.toFixed(3);
  $('trim-summary').textContent = `${(trim.end - trim.start).toFixed(3)} s selection`;
}
async function applyTrim(start, end) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end > clip.duration + 0.001 ||
    end - start < 0.05
  ) {
    throw new Error('Choose a start/end within the clip, with at least 0.05 seconds selected.');
  }
  end = Math.min(end, clip.duration);
  const resume = playing;
  await pause();
  const next = { start, end };
  if (nativeFileId === clip.id) await window.audioLab.command({ command: 'trim', ...next });
  trim = next;
  browser.trim = trim;
  browser.offset = start;
  nativePosition = start;
  nativeEnded = false;
  displayTrim();
  if (resume) await play(true);
  else showStatus('Selection updated. Play or switch & replay to compare.');
}

$('open').onclick = action(async () => {
  const file = await window.audioLab.open();
  if (!file) return;
  await pause();
  const buffer = await browser.load(file.bytes);
  clip = { id: file.id, name: file.name, duration: buffer.duration };
  nativeFileId = null;
  trim = { start: 0, end: buffer.duration };
  browser.trim = trim;
  nativePosition = 0;
  nativeEnded = false;
  spectra = {};
  $('filename').textContent = file.name;
  $('filemeta').textContent =
    `${buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'} · ${buffer.duration.toFixed(2)} s · DeepFilterNet3 processes at 48 kHz`;
  $('trim-start').max = buffer.duration;
  $('trim-end').max = buffer.duration;
  displayTrim();
  showStatus('Clip ready. Set a selection or play the full clip.');
});
$('play').onclick = action(async () => {
  if (playing) {
    await pause();
    showStatus('Playback paused.');
  } else await play();
});
$('restart').onclick = action(async () => {
  await pause();
  await play(true);
});
$('backend').onchange = (event) => {
  const next = event.target.value;
  void action(() => switchBackend(next, false))();
};
$('compare').onclick = action(() => switchBackend(backend === 'au' ? 'dfn' : 'au', true));
$('loop').onchange = action(async () => {
  const resume = playing;
  await pause();
  loop = $('loop').checked;
  if (resume) await play(true);
});
$('apply-trim').onclick = action(() =>
  applyTrim(Number($('trim-start').value), Number($('trim-end').value)),
);
$('reset-trim').onclick = action(() => applyTrim(0, clip.duration));
$('effect').onchange = (event) => {
  const next = event.target.checked;
  void action(async () => {
    enabled = next;
    if (backend === 'au' && nativeFileId !== null) await native('bypass', !enabled);
    browser.setMix(mixes.dfn, enabled);
  })();
};
// Fader changes are cheap and stay ordered on the native command queue; don't disable during dragging.
$('mix').oninput = async () => {
  mixes[backend] = Number($('mix').value);
  $('mix-value').textContent = `${mixes[backend]}%`;
  try {
    if (backend === 'au' && nativeFileId !== null) await native('mix', mixes.au);
    else browser.setMix(mixes.dfn, enabled);
  } catch (error) {
    showStatus(error.message, true);
  }
};

function handleNativeEvent(data) {
  if (data.type === 'ready') {
    auAvailable = data.available;
    auMix = data.parameters.find((parameter) => parameter.id === 0) || auMix;
    if (!auAvailable && backend === 'au') {
      backend = 'dfn';
      nativeFileId = null;
      setPlaying(false);
      showStatus(data.error || 'Audio Unit unavailable. DeepFilterNet3 selected.', true);
    }
    updateControls();
  } else if (backend === 'au') {
    if (data.type === 'spectrum') spectra[data.channel] = data;
    if (data.type === 'looped' && playing) {
      nativePosition = trim.start;
      nativeStartedAt = performance.now();
    }
    if (data.type === 'ended' && !busy) {
      nativeEnded = true;
      nativePosition = trim.start;
      setPlaying(false);
      showStatus('Selection finished.');
    }
    if (data.type === 'error') {
      setPlaying(false);
      showStatus(data.message, true);
    }
  }
}
function renderFrame() {
  if (backend === 'dfn' && browser.ready) spectra = browser.spectra();
  drawSpectrum($('input-graph'), spectra.input, '#86b8bc', playing);
  drawSpectrum($('output-graph'), spectra.output, '#bcf58a', playing);
  if (clip) $('duration').textContent = `${position().toFixed(2)} / ${clip.duration.toFixed(2)} s`;
  requestAnimationFrame(renderFrame);
}
window.audioLab.onEvent(handleNativeEvent);
window.audioLab
  .info()
  .then((info) => {
    $('platform').textContent =
      { darwin: 'macOS', win32: 'WINDOWS', linux: 'LINUX' }[info.platform] || info.platform;
    if (info.ready) handleNativeEvent(info.ready);
    updateControls();
    showStatus('DeepFilterNet3 ready to load a clip. Processing stays local.');
  })
  .catch((error) => showStatus(error.message, true));
renderFrame();
