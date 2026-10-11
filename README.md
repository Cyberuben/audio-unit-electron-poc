# Isolation Lab

An Electron proof of concept for local audio playback through Apple's built-in **AUSoundIsolation** Audio Unit. Open a clip, play/pause, restart, loop, bypass the effect, and adjust its native wet/dry parameter while viewing input/output frequency spectra.

## Run

Use **Node.js 22.12 or newer** (Node 24 LTS recommended). The default Node 20 installed on this development machine is too old for Electron 42.

```sh
npm install
npm start
```

On macOS, install Xcode Command Line Tools (`xcode-select --install`) before the first run. The start script compiles a small Swift executable for the current machine's architecture. **macOS 13+** is required for this host. No loopback driver, AU Lab, or downloaded Audio Unit is needed.

On Windows, the same application uses Web Audio for playback and graphs. Apple Audio Units do not run on Windows; the effect toggle and fader are disabled with an explanation. Windows voice isolation would require an additional cross-platform DSP implementation. Start/build on each target OS; the Mac helper is architecture-specific.

Choose a local mono/stereo audio file using **Open audio**. WAV is a reliable first test; MP3, AAC/M4A, AIFF and FLAC support depends on the platform decoder. Ogg is exposed for the browser backend but may not decode on macOS. Files stay local. Windows decodes clips into memory and limits compressed file size to 200 MB; use short clips to avoid excessive decoded memory. macOS streams scheduled files through AVAudioPlayerNode.

## What the controls mean

- **Play / pause** preserves the current position. **Restart** goes back to the beginning.
- **Loop clip** repeats the clip. The native prototype reschedules after playback completion, so the loop boundary is not sample-accurate/gapless.
- **Effect on** controls the Audio Unit's bypass property.
- **Dry / wet mix** writes the Audio Unit's own parameter (address 0). It is not a speech-detection threshold or a separate host crossfade. The host reads the parameter name, limits and default from the installed Audio Unit. On the tested macOS 15.7.7 system, it reports **−100 to +100**, default +100, despite the SDK header's 0–100 comment. Negative values are passed directly to Apple; this prototype does not assign them an undocumented interpretation.
- Playback goes to the system's default output device. The graph labeled **Output** measures the signal after the effect, including bypass/mix state, before hardware output.

## Architecture

```text
Electron renderer ← narrow preload IPC → Electron main
                                             ↕ JSON lines (controls + spectra)
                                       Swift native host

macOS:    AVAudioPlayerNode → input mixer → AUSoundIsolation → main mixer → device
                                ↓                               ↓
                           original FFT                     output FFT

Windows:  AudioBufferSource → input analyser → gain → output analyser → device
```

macOS hosts the AU with AVAudioEngine/AVAudioUnit; the actual audio stays native rather than travelling through Electron IPC. The helper only hosts AUSoundIsolation in this prototype. Its component description and graph provide a starting point for hosting other Audio Units, but arbitrary plugin discovery/UI is not implemented.

The Mac spectra use 2,048-point Hann-windowed FFTs of channel one, approximately 13 updates per second, shown on a logarithmic 20 Hz–20 kHz axis and a −100–0 dBFS scale. Data above Nyquist is not drawn. Input and output taps run independently; the graphs are not latency-aligned null-test measurements. Windows analysers display the mono downmix while audible stereo is preserved. Bypass therefore produces equivalent signal content, but smoothing/window timing may differ.

FFT and JSON work run off the audio callback. The tap still copies a small buffer and dispatches a task; this is a proof-of-concept host, not a hard-real-time production implementation. A production host should use preallocated ring buffers, handle device/rate changes, smooth parameter changes, and implement seamless looping and latency-aware metering.

Electron uses a sandboxed renderer, context isolation, no Node integration in the UI, a restrictive CSP, no remote navigation, and an allowlisted IPC protocol. File paths come from the main-process picker. The helper is terminated when the app closes.

## Streaming app / DRM implications

This demonstrates native processing **when decoded audio is available to the application**. Selecting an output device does not establish JavaScript access to PCM samples. A speech gate suggests access to some speech/activity signal, but that could also come from metadata or another component. The streaming app's developers would need to confirm where detection runs and whether they can route decoded audio through a native host.

Chromium's media/DRM pipeline, the CDM, stream policies, and origin restrictions determine what is accessible. Web Audio explicitly outputs silence for certain cross-origin media sources. This project does not load DRM video, extract keys, modify a CDM, capture another app, or bypass protected-media restrictions. A live integration would need an authorized decoded-PCM source and synchronization of video with the isolation effect's latency.

References: [Apple AUSoundIsolation component](https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_ausoundisolation), [Web Audio source security](https://www.w3.org/TR/webaudio-1.0/#MediaElementAudioSourceNode-security), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Validation and packaging

```sh
npm test                       # IPC boundary validation
npm run build:native           # compile the macOS helper (no-op on Windows)
python3 tests/native-smoke.py   # macOS: plays a quiet synthetic clip through the real AU
npm run package                # creates an unpacked app in dist/ on the current OS
```

The integration test checks AU discovery, runtime parameter metadata, stereo loading, non-silent finite spectra, pause/resume, mix/bypass commands, completion/restart, looping, and bad-file errors. It requires access to macOS Core Audio and an output device. The packaged app is a local development artifact: distribution signing/notarization and installers are outside this prototype.

For the Electron UI smoke test, make Playwright available (`npm install --no-save playwright`) and run `node tests/electron-smoke.cjs`. It drives the file picker, native playback and controls, saves `dist/screenshot.png`, and exercises the Windows Web Audio renderer in a second window. This fallback test ran on macOS; actual Windows OS execution has not been verified.

## Code layout and formatting

- `src/main.cjs` owns the Electron window, local file picker, and native helper process.
- `src/preload.cjs` exposes the small API available to the sandboxed renderer; `src/protocol.cjs` validates its commands.
- `src/renderer.js` manages controls, playback state, the Web Audio fallback, and spectrum drawing.
- `native/AudioHost.swift` hosts the Audio Unit, schedules playback, and computes input/output spectra off the audio callback.
- `src/index.html` and `src/styles.css` define the interface and layout.

Run `npm run format` to format JavaScript, HTML, CSS, JSON, and Markdown, or `npm run format:check` to check them without modifying files. On macOS, run `npm run format:native` to format Swift using the tool included with Xcode Command Line Tools. Python tests use conventional four-space indentation and are not handled by these commands.

## License

This project is dedicated to the public domain under [CC0 1.0 Universal](LICENSE). To the extent possible under law, all copyright and related rights in the original project code and documentation are waived. You may copy, modify, distribute, and use it commercially without attribution.

Third-party dependencies remain subject to their own licenses. This dedication does not apply to Apple’s Audio Unit implementation or other third-party software.
