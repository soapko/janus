const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

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
    afterCopy: [(buildPath, electronVersion, platform, arch, callback) => {
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
