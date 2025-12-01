const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    name: 'Janus',
    executableName: 'Janus',
    appBundleId: 'com.karl.janus',
    appCategoryType: 'public.app-category.developer-tools',
    asar: {
      unpack: '**/{*.node,node-pty/**/*}'
    },
    // Uncomment and add path when you have an icon
    // icon: './assets/icon',

    // For local development without Apple Developer certificate:
    // - Remove osxSign to skip signing (app won't be distributable but works locally)
    // For distribution, uncomment and configure:
    // osxSign: {
    //   identity: 'Developer ID Application: Your Name (TEAM_ID)',
    //   hardenedRuntime: true,
    //   entitlements: './entitlements.plist',
    //   'entitlements-inherit': './entitlements.plist',
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
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
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
