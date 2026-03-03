/**
 * Sync cumulus: build it, pack as tarball, install into janus.
 * Replaces the old symlink approach with a proper npm install.
 *
 * Usage: node scripts/sync-cumulus.js [--skip-build]
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const skipBuild = process.argv.includes('--skip-build');
const cumulusDir = path.resolve(__dirname, '..', '..', 'cumulus');
const janusDir = path.resolve(__dirname, '..');

if (!fs.existsSync(cumulusDir)) {
  console.error(`[sync-cumulus] Cumulus not found at ${cumulusDir}`);
  process.exit(1);
}

// Build cumulus
if (!skipBuild) {
  console.log('[sync-cumulus] Building cumulus...');
  execSync('npm run build', { cwd: cumulusDir, stdio: 'inherit' });
}

// Pack cumulus into a tarball (stays in cumulus dir so package.json ref is stable)
console.log('[sync-cumulus] Packing cumulus...');
const packOutput = execSync('npm pack', { cwd: cumulusDir, encoding: 'utf8' }).trim();
// npm pack may output prepare script noise before the tarball name — take last line only
const tarball = packOutput.split('\n').pop().trim();
const tarballPath = path.join(cumulusDir, tarball);

// Install the tarball (npm copies files properly, no symlink)
console.log(`[sync-cumulus] Installing ${tarball}...`);
execSync(`npm install ${JSON.stringify(tarballPath)}`, { cwd: janusDir, stdio: 'inherit' });

console.log('[sync-cumulus] Done — cumulus installed from tarball.');
