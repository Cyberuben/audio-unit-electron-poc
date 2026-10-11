const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

mkdirSync(path.join(__dirname, '../native/bin'), { recursive: true });
if (process.platform !== 'darwin') {
  console.log('Audio Unit host is macOS-only; using Web Audio playback.');
  process.exit(0);
}

// Compile for the current CPU and the first macOS release that includes AUSoundIsolation.
const result = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-O',
    '-target',
    `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
    '-module-cache-path',
    '/tmp/isolation-lab-swift-cache',
    path.join(__dirname, '../native/AudioHost.swift'),
    '-o',
    path.join(__dirname, '../native/bin/au-host'),
  ],
  { stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
