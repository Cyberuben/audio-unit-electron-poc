const $ = (id) => document.getElementById(id);

// Both backends share UI state. macOS reports playback events; Web Audio updates it locally.
let usesNativeHost = false;
let loaded = false;
let playing = false;
let ended = false;

// The browser fallback recreates its one-shot source node on each play/resume.
let audioContext;
let audioBuffer;
let playbackSource;
let inputAnalyser;
let outputAnalyser;
let playbackOffset = 0;
let playbackStartedAt = 0;
const spectra = { input: null, output: null };

function showStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function setPlaying(value) {
  playing = value;
  $('play').textContent = value ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', value ? 'Pause audio' : 'Play audio');
}

function showLoadedClip(data) {
  loaded = true;
  ended = false;
  setPlaying(false);
  $('filename').textContent = data.name;
  $('filemeta').textContent =
    `${(data.sampleRate / 1000).toFixed(1)} kHz · ${data.channels === 1 ? 'Mono' : 'Stereo'} · Ready to play`;
  $('duration').textContent =
    `${Math.floor(data.duration / 60)}:${String(Math.floor(data.duration % 60)).padStart(2, '0')} DURATION`;
  for (const id of ['play', 'restart', 'loop']) $(id).disabled = false;
  showStatus('Clip ready. Press play to listen.');
}

// Native events contain metadata and FFT bins; audio samples stay in the Swift process.
function handleNativeEvent(data) {
  if (data.type === 'ready') {
    $('open').disabled = false;
    // Ask the installed AU for its range: it can differ from the SDK documentation.
    const mix = data.parameters.find((p) => p.id === 0);
    $('effect').disabled = !data.available;
    $('mix').disabled = !data.available || !mix;
    if (mix) {
      $('mix').min = mix.min;
      $('mix').max = mix.max;
      $('mix').value = mix.value;
      $('mix-value').textContent = `${mix.value}%`;
      $('mix-min').textContent = `${mix.min}%${mix.min === 0 ? ' · Original' : ''}`;
      $('mix-max').textContent = `${mix.max}% · Isolated`;
    }
    if (!data.available) {
      $('effect').checked = false;
      $('effect-label').textContent = 'Unavailable';
      $('effect-description').textContent =
        'AUSoundIsolation is unavailable on this Mac. Original audio playback is still available.';
    }
    showStatus(
      data.available
        ? 'Native Audio Unit connected. Open a clip to begin.'
        : data.error || 'Audio Unit unavailable; original playback only.',
    );
  } else if (data.type === 'loaded') showLoadedClip(data);
  else if (data.type === 'playing') {
    setPlaying(true);
    showStatus('Playing through the native audio engine.');
  } else if (data.type === 'paused') {
    setPlaying(false);
    showStatus('Playback paused.');
  } else if (data.type === 'ended') {
    ended = true;
    setPlaying(false);
    showStatus('Playback finished.');
  } else if (data.type === 'spectrum') spectra[data.channel] = data;
  else if (data.type === 'error') {
    setPlaying(Boolean(data.playing));
    showStatus(data.message, true);
  }
}

async function sendNativeCommand(name, value) {
  await window.audioLab.command({ command: name, value });
}

// Clear onended before stopping so a pause is not mistaken for natural completion.
function stopBrowserPlayback() {
  if (playbackSource) {
    playbackSource.onended = null;
    playbackSource.stop();
    playbackSource.disconnect();
    playbackSource = null;
  }
}

// AudioBufferSourceNode cannot be restarted, so resume with a new node at the saved offset.
function startBrowserPlayback() {
  playbackSource = audioContext.createBufferSource();
  playbackSource.buffer = audioBuffer;
  playbackSource.loop = $('loop').checked;
  playbackSource.connect(inputAnalyser);
  playbackStartedAt = audioContext.currentTime;
  playbackSource.onended = () => {
    playbackSource.disconnect();
    playbackSource = null;
    playbackOffset = 0;
    ended = true;
    setPlaying(false);
    showStatus('Playback finished.');
  };
  playbackSource.start(0, playbackOffset % audioBuffer.duration);
  setPlaying(true);
  ended = false;
  showStatus('Playing original audio · Web Audio');
}

// Keep async click-handler failures visible in the status line.
function withErrorReporting(action) {
  return async () => {
    try {
      await action();
    } catch (error) {
      showStatus(error.message, true);
    }
  };
}

// Playback and effect controls dispatch to the active backend.
$('open').onclick = withErrorReporting(async () => {
  $('open').disabled = true;
  try {
    const file = await window.audioLab.open();
    if (!file || file.native) return;
    audioContext ||= new AudioContext();
    const next = await audioContext.decodeAudioData(new Uint8Array(file.bytes).buffer);
    if (next.numberOfChannels > 2) throw new Error('Use a mono or stereo clip.');
    stopBrowserPlayback();
    audioBuffer = next;
    playbackOffset = 0;
    if (!inputAnalyser) {
      inputAnalyser = audioContext.createAnalyser();
      outputAnalyser = audioContext.createAnalyser();
      for (const analyser of [inputAnalyser, outputAnalyser]) {
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.65;
      }
      const audible = audioContext.createGain();
      // Analysers measure a mono downmix but pass the original stereo audio through.
      inputAnalyser.connect(audible);
      audible.connect(outputAnalyser);
      outputAnalyser.connect(audioContext.destination);
    }
    showLoadedClip({
      name: file.name,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      duration: audioBuffer.duration,
    });
  } finally {
    $('open').disabled = false;
  }
});

$('play').onclick = withErrorReporting(async () => {
  if (!loaded) return;
  if (usesNativeHost) {
    if (ended) {
      await sendNativeCommand('restart');
      ended = false;
    }
    await sendNativeCommand(playing ? 'pause' : 'play');
  } else {
    await audioContext.resume();
    if (playing) {
      playbackOffset =
        (playbackOffset + audioContext.currentTime - playbackStartedAt) % audioBuffer.duration;
      stopBrowserPlayback();
      setPlaying(false);
      showStatus('Playback paused.');
    } else startBrowserPlayback();
  }
});

$('restart').onclick = withErrorReporting(async () => {
  ended = false;
  if (usesNativeHost) await sendNativeCommand('restart');
  else {
    const resume = playing;
    stopBrowserPlayback();
    playbackOffset = 0;
    if (resume) startBrowserPlayback();
  }
});

$('loop').onchange = withErrorReporting(async () => {
  if (usesNativeHost) await sendNativeCommand('loop', $('loop').checked);
  else if (playbackSource) playbackSource.loop = $('loop').checked;
});

$('effect').onchange = withErrorReporting(async () => {
  await sendNativeCommand('bypass', !$('effect').checked);
  $('effect-label').textContent = $('effect').checked ? 'Effect on' : 'Bypassed';
  $('mix').disabled = !$('effect').checked;
});

$('mix').oninput = withErrorReporting(async () => {
  $('mix-value').textContent = `${$('mix').value}%`;
  await sendNativeCommand('mix', Number($('mix').value));
});

// Draw dBFS vertically and frequency logarithmically, using the same scale for both graphs.
function drawSpectrum(canvas, data, color) {
  // Scale the backing canvas for Retina/high-DPI displays without changing CSS dimensions.
  const ratio = window.devicePixelRatio || 1,
    width = canvas.clientWidth,
    height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#2b3931';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#687f70';
  ctx.font = '9px monospace';
  for (const db of [0, -25, -50, -75, -100]) {
    const y = 6 + (-db / 100) * (height - 16);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillText(`${db}`, 2, Math.max(12, y - 3));
  }
  if (!data || !playing) return;
  const { bins, sampleRate } = data;
  const points = [];
  // Keep the strongest FFT bin per pixel band so narrow peaks remain visible.
  for (let x = 0; x <= width; x += 2) {
    const hz = 20 * Math.pow(1000, x / width),
      nextHz = 20 * Math.pow(1000, (x + 2) / width);
    if (hz > sampleRate / 2) break;
    const low = Math.max(1, Math.floor((hz / (sampleRate / 2)) * bins.length));
    const high = Math.min(
      bins.length - 1,
      Math.max(low, Math.ceil((nextHz / (sampleRate / 2)) * bins.length)),
    );
    let db = -100;
    for (let i = low; i <= high; i++) db = Math.max(db, bins[i]);
    points.push([x, 6 + (1 - Math.min(1, Math.max(0, (db + 100) / 100))) * (height - 16)]);
  }
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const point of points) ctx.lineTo(...point);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(points.at(-1)[0], height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${color}45`);
  gradient.addColorStop(1, `${color}03`);
  ctx.fillStyle = gradient;
  ctx.fill();
}

function renderFrame() {
  if (!usesNativeHost && inputAnalyser && playing) {
    for (const [name, analyser] of [
      ['input', inputAnalyser],
      ['output', outputAnalyser],
    ]) {
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      spectra[name] = { bins, sampleRate: audioContext.sampleRate };
    }
  }
  drawSpectrum($('input-graph'), spectra.input, '#86b8bc');
  drawSpectrum($('output-graph'), spectra.output, '#bcf58a');
  requestAnimationFrame(renderFrame);
}

// Subscribe before requesting initial state: the native host may already be ready.
window.audioLab.onEvent(handleNativeEvent);
window.audioLab
  .info()
  .then((info) => {
    usesNativeHost = info.native;
    $('platform').textContent = usesNativeHost ? 'macOS / AUDIO UNIT' : 'WINDOWS / WEB AUDIO';
    if (info.ready) handleNativeEvent(info.ready);
    if (!usesNativeHost) {
      $('open').disabled = false;
      $('effect').checked = false;
      $('effect-label').textContent = 'macOS only';
      $('effect-description').textContent =
        'Audio Units are a macOS technology. Windows supports original playback and spectrum analysis; isolation requires a separate DSP backend.';
      document.querySelector('.note').textContent =
        'Windows spectra show the mono downmix, −100 to 0 dBFS. Both signals are identical without an effect. Playback uses your default audio output.';
      showStatus('Web Audio ready. Open a clip to begin.');
    }
  })
  .catch((error) => showStatus(error.message, true));
renderFrame();
