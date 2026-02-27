/**
 * Pre-package script: Replace the cumulus symlink with actual files
 * so electron-packager/asar can bundle them.
 */
const fs = require('fs');
const path = require('path');

const cumulusLink = path.join(__dirname, '..', 'node_modules', 'cumulus');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'src') continue;
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  const stat = fs.lstatSync(cumulusLink);
  if (stat.isSymbolicLink()) {
    const realPath = fs.realpathSync(cumulusLink);
    fs.unlinkSync(cumulusLink);
    copyDirSync(realPath, cumulusLink);
    // Strip dependencies from copied package.json so electron-packager
    // doesn't try to resolve cumulus's own deps (pdfjs-dist, etc.)
    const pkgPath = path.join(cumulusLink, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      delete pkg.dependencies;
      delete pkg.devDependencies;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    console.log(`[prepackage] Replaced symlink with real files from: ${realPath}`);
  } else {
    console.log('[prepackage] cumulus is not a symlink, nothing to do');
  }
} catch (err) {
  console.error('[prepackage] Error:', err.message);
  process.exit(1);
}
