# Third-party notices

The original Isolation Lab code is dedicated under CC0. That dedication does not relicense any dependency, compiled runtime, or pretrained model.

## Noise suppression and model

- **@workadventure/noise-suppression 0.2.0**: MIT, copyright 2026 WorkAdvetu.re (spelling retained from upstream). The complete notice is in `licenses/WorkAdventure-noise-suppression-MIT.txt` and is also copied into `src/vendor/deepfilternet/LICENSE`. [Source revision](https://github.com/workadventure/noise-suppression/tree/7e00a1b7522f044a31776fddc249a97a98de94ed).
- **DeepFilterNet / libDF**: upstream offers MIT or Apache-2.0. Both texts are retained in `licenses/DeepFilterNet-MIT.txt` and `licenses/DeepFilterNet-APACHE.txt`. WorkAdventure identifies source revision `d375b2d8309e0935d165700c91da9de862a99c31` and builds a patched WASM version. `licenses/deepfilternet-provenance.json` links its build script and patch and records SHA-256 hashes of the unmodified assets redistributed here. [DeepFilterNet source](https://github.com/Rikorose/DeepFilterNet).
- **DeepFilterNet3 pretrained ONNX archive**: supplied unchanged by the WorkAdventure package. Upstream has an [open request to clarify licensing of pretrained weights](https://github.com/Rikorose/DeepFilterNet/issues/697). Retaining the code licenses does not settle that question or establish a separate license grant for the weights.
- **Rust dependencies in the WASM**: retained license, copyright, and notice texts are in `licenses/wasm-crates/`. Its `inventory.json` records exact crate versions, archive hashes, and text provenance. It covers 45 crates identifiable through embedded registry source paths; it is a lower bound, **not a complete SBOM**. The package does not provide the final WASM build's complete dependency inventory. RealFFT 3.3.0 declares MIT but supplies no standalone license text; its notice records the package author and standard MIT terms with that limitation clearly marked. A complete redistribution audit requires the final dependency inventory from the WASM producer and clarification of the model license.

Reference: Schröter et al., “DeepFilterNet: Perceptually Motivated Real-Time Speech Enhancement,” INTERSPEECH 2023.

Only the DeepFilterNet3 JavaScript, worklet, WASM, and model are copied from the package. Its DTLN, Silero, and ONNX Runtime Web assets are not bundled. The model and WASM are installed through npm with lockfile integrity verification and bundled locally; the application does not download models or upload audio at runtime.

## Electron and Chromium

Electron's MIT notice and its generated Chromium and third-party notices are copied unchanged from the installed Electron distribution to `src/vendor/electron/LICENSE` and `src/vendor/electron/LICENSES.chromium.html`. These generated files are included in the packaged application, inside `resources/app.asar` (on macOS, `Contents/Resources/app.asar`). They are not checked into this repository; `npm run build:assets` copies the texts for the installed version.

Build tools retain their own licenses in their installed packages. Apple Audio Units are supplied by macOS and are not redistributed by this repository.

## Maintaining the notices

`npm run build:assets` checks the pinned noise-suppression version, wrapper license, and hashes of all four redistributed assets. An upgrade must include review of the corresponding notices and provenance. Packaging checks that this document, the root license, every file under `licenses/`, and both generated Electron notices are preserved byte-for-byte in `app.asar`. These checks verify retention of the notices collected here; they do not resolve the upstream inventory and model-license gaps described above.
