import { requireOptionalNativeModule } from 'expo';

// The app's own Android code (android/ in this folder): incoming calls that
// pop up over other apps and the lock screen, the phone's ringtone, message
// notifications, keeping a call going in the background and picture in
// picture. It's null where the native part isn't built in, such as Expo Go,
// and the app then works as a plain WebView.
export default requireOptionalNativeModule('TailchatCalls');
