# Isolation Lab

An Electron proof of concept for comparing **DeepFilterNet3** voice denoising with Apple's built-in **AUSoundIsolation**. Open a local clip, select a short passage, loop it, and switch effects with one button while watching the original and processed spectra.

| Platform | DeepFilterNet3         | AUSoundIsolation                             |
| -------- | ---------------------- | -------------------------------------------- |
| macOS    | Yes, local WebAssembly | macOS 13+, when the built-in AU is available |
| Windows  | Yes, local WebAssembly | Unavailable                                  |
| Linux    | Yes, local WebAssembly | Unavailable                                  |

## Run

Use **Node.js 22.12 or newer** (Node 24 recommended; `.nvmrc` selects it).

```sh
npm ci
npm start
```

On macOS, install Xcode Command Line Tools (`xcode-select --install`) to compile the Swift AU host. The native build is skipped on Windows and Linux. No loopback driver or AU Lab is required. If the Mac helper cannot start, DeepFilterNet3 remains available.

`npm start` copies the DeepFilterNet3 processor, WASM, model, and license from the pinned `@workadventure/noise-suppression` npm package into the ignored `src/vendor/` directory. Those assets are included in packaged apps; **no model downloads or audio uploads occur at runtime**.

Open a mono/stereo clip smaller than 100 MB and no longer than ten minutes. Browser playback decodes the clip into memory and resamples to 48 kHz; long or highly compressed files can still use substantial memory. WAV is the most reliable comparison format. Other formats depend on Chromium's decoder and, for the Apple effect, AVAudioFile support. A file must decode in Chromium to load in this comparison app.

## Compare the same passage

1. Open a clip.
2. Enter **Start** and **End** in seconds, then click **Apply trim**. Select at least 0.05 seconds. This is non-destructive: the original file is never modified.
3. Enable **Loop selection** and press **Play**.
4. On Mac, click **Switch to … & replay** repeatedly. Each click stops the current engine, switches to the other effect, and plays from the start of the same selection. It also starts playback if previously paused.

The **Processing engine** selector switches effects too, but preserves whether playback was active. A switch while playing restarts the selection; a switch while paused leaves it paused. **Restart** always plays from the selection's start. **Full clip** resets the trim. Applying trim or changing looping during playback restarts the selection.

Play/pause preserves position within the selection. The displayed native playhead is an approximate UI clock; actual trim boundaries are scheduled in native sample frames. Native looping reschedules after completion and is not guaranteed gapless. The browser source loops at its sample boundaries, but denoising retains context across loops. This is a listening comparison, not a sample-aligned scientific benchmark or automatic loudness match.

## Effect and mix controls

**DeepFilterNet3** runs at 48 kHz, using one mono processor per channel to preserve stereo. Stereo costs roughly twice the inference work. The model's suppression limit is 25 dB; the additional pause gate and automatic post-gain are disabled, so the comparison focuses on denoising. A visible error is shown for overloads or processor failures.

Its **0–100% dry/wet** fader blends original and processed audio. The dry path uses the upstream documented nominal delay (30 ms model + 512 samples of worklet reframing, approximately 41 ms) to reduce timing differences when blending. Bypass uses this delayed dry path too. Algorithmic phase changes mean partial mixes need not perfectly reconstruct the original. The model is initialized on first playback and reused; its context is suspended while paused or while Apple processing is active, and closed when another clip is loaded to release WASM memory.

**AUSoundIsolation** is instantiated natively through AVAudioEngine. Its fader controls Apple's own wet/dry parameter, including the **−100 to +100** range reported by the tested macOS 15.7.7 installation. Negative values are passed directly to Apple, without an undocumented interpretation. The toggle controls the AU's bypass property. Each effect remembers its own mix setting; the signed Apple parameter and DeepFilterNet3's linear blend are not equivalent scales.

Playback uses the system's default output device. The original spectrum is measured before processing; output is measured after processing and mixing. Mac AU spectra analyze channel one with a 2,048-point Hann-windowed FFT; browser analysers use their built-in mono downmix and window. Both use a logarithmic 20 Hz–20 kHz display and −100 to 0 dBFS scale, but windowing, normalization, and engine latency differ. Do not treat differences in these graphs as a calibrated null test.

## Architecture

```text
Electron renderer ← narrow preload IPC → Electron main → Swift AU host (Mac only)

AUSoundIsolation:
  AVAudioPlayerNode scheduled segment → input mixer → AU → output mixer → device
                                          ↓                  ↓
                                     original FFT        output FFT

DeepFilterNet3 (all platforms):
  trimmed AudioBufferSource → input analyser → channel splitter → mono WASM models
                                    │                              ↓
                                    │                        channel merger → wet gain
                                    ↓                                           │
                             dry delay → dry gain ──────────────────────────────┤
                                                                               ↓
                                                               output analyser → device
```

Native command acknowledgements let the renderer wait for pause/trim/load operations before switching. The native output is muted on pause and the browser output is muted/suspended, preventing a second engine from continuing underneath the comparison.

The renderer has no Node access. It runs with context isolation, sandboxing, and a restrictive CSP. A secure local `lab://app` protocol serves bundled modules/model assets for AudioWorklet and WASM. File selection remains in the main process; opaque tokens authorize native loading instead of renderer-supplied paths. Navigation, popups, and permission requests are blocked. The helper exits when the app closes.

## Streaming app / DRM implications

This proves processing when decoded audio is available. Selecting an output device does not establish JavaScript access to PCM. A speech gate could use audio analysis, metadata, or another component; the streaming app's developers must confirm whether they can supply an authorized decoded audio source.

Neither backend opens DRM video or bypasses its restrictions. A live integration would require accessible audio and compensation for processing latency to preserve video synchronization. Web Audio can also return silence for restricted cross-origin media.

References: [WorkAdventure noise suppression](https://github.com/workadventure/noise-suppression), [Apple AUSoundIsolation](https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_ausoundisolation), [Web Audio source security](https://www.w3.org/TR/webaudio-1.0/#MediaElementAudioSourceNode-security).

## Validation and packaging

```sh
npm test                       # Command validation, including trim boundaries
npm run format:check
npm run build:assets           # Offline renderer assets from installed npm package
npm run build:native            # macOS host; no-op on other platforms
python3 tests/native-smoke.py   # Mac: quiet test clip through the real AU
npm run package                # Unpacked app in dist/ for the current OS
```

With Playwright available, run `node tests/electron-smoke.cjs`. It exercises real DeepFilterNet3 processing, measures attenuation and dry output, tests repeated Mac switching, trim loops, pause/resume, bypass, invalid ranges, and completion. It also exercises Windows/Linux renderer configurations without invoking the native backend. Those configuration tests run on the host OS and do not substitute for testing on actual Windows/Linux machines. A screenshot is saved to `dist/comparison.png`.

Native tests verify that trimming selects the correct audio region by checking a tone present only inside the selection. Tests play quiet synthetic audio and require access to an output device. Builds are unsigned local development artifacts. Native helpers are built for the current Mac architecture; distribution signing, notarization, and installers are outside this prototype.

## Code layout and formatting

- `src/main.cjs`: Electron lifecycle, secure local assets, file picker, native request/ack bridge.
- `src/preload.cjs` / `src/protocol.cjs`: restricted renderer API and command validation.
- `src/renderer.js`: shared UI, trim state, selection, and backend switching.
- `src/browser-engine.js`: DeepFilterNet3 graph, stereo processing, mix, and browser playback.
- `src/spectrum.js`: shared canvas spectrum display.
- `native/AudioHost.swift`: Audio Unit host, scheduled trim segments, and FFT taps.
- `scripts/build-assets.cjs`: bundles only the DeepFilterNet3 assets, not the package's unrelated models.

`npm run format` formats JS, HTML, CSS, JSON, and Markdown. `npm run format:native` formats Swift with Xcode Command Line Tools. Generated third-party assets are excluded from formatting and version control.

## License

The original project code and documentation are dedicated under [CC0 1.0 Universal](LICENSE). To the extent possible under law, copyright and related rights are waived. You may copy, modify, distribute, and use them commercially without attribution.

Third-party software retains its own licenses. The DeepFilterNet3 integration does not relicense the package, runtime, or model under CC0. See [third-party notices](THIRD_PARTY_NOTICES.md) for retained license texts, asset provenance, and the unresolved upstream model-license and WASM dependency-inventory questions. Builds copy Electron/Chromium notices from the installed distribution; packaging verifies that all collected notices are retained in the app.
