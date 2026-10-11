const { copyFileSync, mkdirSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');
const provenance = require('../licenses/deepfilternet-provenance.json');
const packageRoot = path.dirname(require.resolve('@workadventure/noise-suppression/package.json'));
const installed = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

// A package upgrade requires reviewing its notices and regenerating the asset inventory.
assert.equal(
  installed.version,
  provenance.version,
  'Review licenses before upgrading DeepFilterNet',
);
assert.deepEqual(
  readFileSync(path.join(packageRoot, 'LICENSE')),
  readFileSync(path.join(root, 'licenses/WorkAdventure-noise-suppression-MIT.txt')),
  'The installed package license differs from the retained notice',
);
for (const [file, expectedHash] of Object.entries(provenance.assets)) {
  const source = path.join(packageRoot, 'dist', file);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  assert.equal(hash, expectedHash, `Review dependency notices for changed asset: ${file}`);
}

function copy(source, relativeDestination) {
  const destination = path.join(root, 'src/vendor', relativeDestination);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

// Preserve relative paths for import.meta.url lookups; omit unrelated package models.
for (const file of Object.keys(provenance.assets)) {
  copy(path.join(packageRoot, 'dist', file), `deepfilternet/${file}`);
}
copy(path.join(packageRoot, 'LICENSE'), 'deepfilternet/LICENSE');

// electron-builder does not retain these standalone files in every platform's app.
// Copy the notices from the actual installed Electron distribution into app.asar.
const electronRoot = path.dirname(require.resolve('electron/package.json'));
for (const file of ['LICENSE', 'LICENSES.chromium.html']) {
  copy(path.join(electronRoot, 'dist', file), `electron/${file}`);
}
console.log('Bundled offline DeepFilterNet3 assets and dependency license notices.');
