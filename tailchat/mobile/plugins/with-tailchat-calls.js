// Picture in picture for calls. Tailchat's activity may shrink into a small
// window, and it must not restart when it does: that would reload the page
// and end the call. The rest of the call code (ringing, the pop-up, the lock
// screen, keeping a call going) is the native module in
// modules/tailchat-calls, which brings its own manifest entries.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const CONFIG_CHANGES = ['keyboard', 'keyboardHidden', 'orientation', 'screenSize', 'smallestScreenSize', 'screenLayout', 'uiMode'];

module.exports = function withTailchatCalls(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    activity.$['android:supportsPictureInPicture'] = 'true';
    activity.$['android:resizeableActivity'] = 'true';
    const changes = new Set((activity.$['android:configChanges'] || '').split('|').filter(Boolean));
    for (const c of CONFIG_CHANGES) changes.add(c);
    activity.$['android:configChanges'] = [...changes].join('|');
    return cfg;
  });
};
