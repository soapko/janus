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

// Restore moonshine-js package.json (re-add the file: dependency)
try {
  const moonshinePkgPath = path.join(__dirname, '..', 'node_modules', '@moonshine-ai', 'moonshine-js', 'package.json');
  if (fs.existsSync(moonshinePkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(moonshinePkgPath, 'utf8'));
    if (pkg.dependencies && !pkg.dependencies['@ricky0123/vad-web']) {
      pkg.dependencies['@ricky0123/vad-web'] = 'file:../vad-moonshine/packages/web';
      fs.writeFileSync(moonshinePkgPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log('[postpackage] Restored moonshine-js @ricky0123/vad-web dependency');
    }
  }
} catch (err) {
  console.error('[postpackage] Warning - moonshine-js restore:', err.message);
}
