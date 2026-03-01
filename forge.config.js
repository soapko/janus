const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

// Resolve the cumulus symlink from the SOURCE project (not the temp build dir)
const SOURCE_DIR = __dirname;
const CUMULUS_REAL_PATH = fs.realpathSync(path.join(SOURCE_DIR, 'node_modules', 'cumulus'));

module.exports = {
  packagerConfig: {
    name: 'Janus',
    executableName: 'Janus',
    appBundleId: 'com.karl.janus',
    appCategoryType: 'public.app-category.developer-tools',
    // Asar disabled — MCP server scripts (cumulus-history, janus-agents) need to be
    // readable by regular node processes spawned by Claude CLI, which can't read from
    // inside .asar archives. Disabling asar ensures all paths just work.
    asar: false,
    // Resolve symlinked dependencies (e.g. cumulus via file:../cumulus) before ASAR packaging.
    // The symlink in the temp build dir points to a relative path that doesn't exist,
    // so we resolve the real path from the source project at config-load time.
    afterCopy: [(buildPath, electronVersion, platform, arch, callback) => {
      const cumulusLink = path.join(buildPath, 'node_modules', 'cumulus');
      try {
        const stat = fs.lstatSync(cumulusLink);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(cumulusLink);
          // Copy only the files needed for runtime (dist + package.json)
          fs.mkdirSync(cumulusLink, { recursive: true });
          fs.cpSync(path.join(CUMULUS_REAL_PATH, 'dist'), path.join(cumulusLink, 'dist'), { recursive: true });
          fs.copyFileSync(path.join(CUMULUS_REAL_PATH, 'package.json'), path.join(cumulusLink, 'package.json'));
          // Copy only essential cumulus node_modules (skip large/problematic ones like pdfjs-dist)
          const nmSrc = path.join(CUMULUS_REAL_PATH, 'node_modules');
          if (fs.existsSync(nmSrc)) {
            const nmDst = path.join(cumulusLink, 'node_modules');
            fs.mkdirSync(nmDst, { recursive: true });
            const entries = fs.readdirSync(nmSrc);
            const skipList = new Set(['.cache', '.package-lock.json']);
            for (const entry of entries) {
              if (skipList.has(entry)) continue;
              const srcPath = path.join(nmSrc, entry);
              const dstPath = path.join(nmDst, entry);
              try {
                fs.cpSync(srcPath, dstPath, { recursive: true });
              } catch (e) {
                console.warn(`[forge] Skipped cumulus dep ${entry}: ${e.message}`);
              }
            }
          }
          console.log('[forge] Resolved cumulus symlink -> copied dist + package.json');
        }
      } catch (err) {
        console.warn('[forge] Failed to resolve cumulus symlink:', err.message);
      }

      // Fix broken @ricky0123/vad-web symlink — it's bundled into moonshine.min.js,
      // but the dependency walker needs a resolvable module
      const vadWebLink = path.join(buildPath, 'node_modules', '@ricky0123', 'vad-web');
      try {
        const vadStat = fs.lstatSync(vadWebLink);
        if (vadStat.isSymbolicLink()) {
          fs.unlinkSync(vadWebLink);
          fs.mkdirSync(vadWebLink, { recursive: true });
          fs.writeFileSync(path.join(vadWebLink, 'package.json'), JSON.stringify({ name: '@ricky0123/vad-web', version: '0.0.24', main: 'index.js' }));
          fs.writeFileSync(path.join(vadWebLink, 'index.js'), 'module.exports = {};');
          console.log('[forge] Created stub for @ricky0123/vad-web (bundled in moonshine)');
        }
      } catch (err) {
        // Symlink might not exist in build dir — that's fine
      }

      callback();
    }],
    // Uncomment and add path when you have an icon
    // icon: './assets/icon',

    // Sign with Apple Developer certificate (disabled temporarily — re-enable with asar)
    // osxSign: {
    //   identity: 'Apple Development: Karl Tiedemann (762ZX5X3W2)',
    // },
    // osxNotarize: {
    //   appleId: process.env.APPLE_ID,
    //   appleIdPassword: process.env.APPLE_PASSWORD,
    //   teamId: process.env.APPLE_TEAM_ID
    // }
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        name: 'Janus',
        format: 'ULFO',
        // Uncomment when you have icons
        // icon: './assets/icon.icns',
        // background: './assets/dmg-background.png',
        window: {
          size: {
            width: 540,
            height: 380
          }
        }
      },
    },
  ],
  plugins: [
    // auto-unpack-natives removed — not needed with asar: false
    // Fuses disabled for now - they modify binaries and cause signature issues
    // Re-enable when you have proper code signing set up
    // new FusesPlugin({
    //   version: FuseVersion.V1,
    //   [FuseV1Options.RunAsNode]: false,
    //   [FuseV1Options.EnableCookieEncryption]: true,
    //   [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    //   [FuseV1Options.EnableNodeCliInspectArguments]: false,
    //   [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    //   [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // }),
  ],
};
