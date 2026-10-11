const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

function filesBelow(root, relative) {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? filesBelow(root, file) : [file];
  });
}

// Fail packaging if a file filter drops or alters any of the retained notices.
module.exports = async function verifyPackagedLicenses(context) {
  const { extractFile } = await import('@electron/asar');
  const root = context.packager.projectDir;
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents/Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  const files = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    ...filesBelow(root, 'licenses'),
    'src/vendor/deepfilternet/LICENSE',
    'src/vendor/electron/LICENSE',
    'src/vendor/electron/LICENSES.chromium.html',
  ];
  for (const file of files) {
    assert.deepEqual(
      extractFile(archive, file),
      readFileSync(path.join(root, file)),
      `Packaged license notice is missing or changed: ${file}`,
    );
  }
  console.log(`Verified ${files.length} packaged license and provenance files.`);
};
