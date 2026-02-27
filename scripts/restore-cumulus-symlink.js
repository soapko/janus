/**
 * Post-package script: Restore the cumulus symlink for development.
 */
const fs = require('fs');
const path = require('path');

const cumulusLink = path.join(__dirname, '..', 'node_modules', 'cumulus');

try {
  const stat = fs.lstatSync(cumulusLink);
  if (stat.isDirectory()) {
    fs.rmSync(cumulusLink, { recursive: true });
    fs.symlinkSync('../../cumulus', cumulusLink);
    console.log('[postpackage] Restored cumulus symlink');
  } else {
    console.log('[postpackage] cumulus is already a symlink, nothing to do');
  }
} catch (err) {
  console.error('[postpackage] Error:', err.message);
  // Non-fatal - don't block the build
}
