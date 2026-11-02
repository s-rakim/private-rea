// Picture in picture for calls. Tailchat's activity may shrink into a small
// window, and it must not restart when it does: that would reload the page
// and end the call. The rest of the call code (ringing, the pop-up, the lock
// screen, keeping a call going) is the native module in
// modules/tailchat-calls, which brings its own manifest entries.
//
// It also turns off the emoji font AndroidX loads from Google Play services
// when the app starts. Holding that font open ties Tailchat to Play
// services' process: when that process restarts (an update, or a busy
// phone), Android closes every app holding its fonts, and Tailchat would
// stop ringing until it was opened again. The app's own screens are a web
// page with its own fonts, so nothing shows differently.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const CONFIG_CHANGES = ['keyboard', 'keyboardHidden', 'orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'uiMode'];
const STARTUP = 'androidx.startup.InitializationProvider';
const EMOJI = 'androidx.emoji2.text.EmojiCompatInitializer';

module.exports = function withTailchatCalls(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    activity.$['android:supportsPictureInPicture'] = 'true';
    activity.$['android:resizeableActivity'] = 'true';
    const changes = new Set((activity.$['android:configChanges'] || '').split('|').filter(Boolean));
    for (const c of CONFIG_CHANGES) changes.add(c);
    activity.$['android:configChanges'] = [...changes].join('|');

    cfg.modResults.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    app.provider = app.provider || [];
    let startup = app.provider.find((p) => p.$?.['android:name'] === STARTUP);
    if (!startup) {
      startup = {
        $: {
          'android:name': STARTUP,
          'android:authorities': '${applicationId}.androidx-startup',
          'android:exported': 'false',
          'tools:node': 'merge',
        },
      };
      app.provider.push(startup);
    }
    startup['meta-data'] = (startup['meta-data'] || []).filter((m) => m.$?.['android:name'] !== EMOJI);
    startup['meta-data'].push({ $: { 'android:name': EMOJI, 'tools:node': 'remove' } });
    return cfg;
  });
};
