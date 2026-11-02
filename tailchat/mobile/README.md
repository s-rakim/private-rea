# Tailchat for Android

An Expo app that runs Tailchat's web app in a WebView, plus Android code of
its own (`modules/tailchat-calls`) for what a web page can't do: ringing like
a phone, calls that pop up over other apps, notifications with Reply, and
calls that carry on in the background. The first screen asks for your
server's address (for example `https://tailchat.your-tailnet.ts.net`) and
remembers it. The phone must be connected to your tailnet with the Tailscale
app.

## Calls

* **Incoming calls ring with the phone's own ringtone** and vibrate, and
  follow silent and vibrate mode and Do Not Disturb. The power button
  silences a ringing call.
* **While you use another app**, an incoming call pops up as a card at the
  top of the screen with the caller's photo, **Answer** and **Decline**. It
  doesn't take over the screen: tap the card to open Tailchat, or swipe it up
  to put the call away in the notifications, where it keeps ringing.
* **On the lock screen**, an incoming call fills the screen and turns it on,
  with Answer, Decline and (for video calls) Voice only. A call answered
  there shows over the lock screen until it ends.
* **With Tailchat open**, its own ring screen shows, with quick replies.
* **Calls carry on in the background**: leave the app and the call goes on,
  with Mute and Hang up in its notification.
* **Picture in picture**: leave the app during a video call and it carries on
  in a small window that you can move around, with Mute and Hang up.
* **Speaker or earpiece**: video calls start on the speaker, voice calls at
  your ear (the screen turns off when you hold the phone to your ear), and
  headphones take over when they're connected. The **Speaker** button in the
  call's **More** sheet switches.
* **Missed calls** leave a notification with **Call back**.

## Messages

New messages pop up with the sender's photo and a preview, grouped by chat,
with **Reply** (type your answer right in the notification) and **Mark as
read**. Muted chats stay quiet, and the chat you're looking at doesn't
notify. Turn them off in **Settings > Notifications**. Notifications are made
on the phone after decryption, so the server never sees what they say.

## Settings to allow

Android asks for some of these the first time; the rest are in Tailchat under
**Settings > Calls**, each with a button that opens the right page of the
phone's settings:

| Setting | What it's for |
|---|---|
| Notifications | calls, missed calls and messages |
| Display over other apps | the call pop-up while you use another app |
| Full screen notifications (Android 14 and later) | incoming calls on the lock screen |
| Battery: Unrestricted | so Android doesn't put Tailchat to sleep and miss calls |
| Picture in picture | the small window during video calls |

**Stay connected in the background** (on by default) keeps Tailchat's
connection to your server open while you use other apps, so calls ring and
messages arrive. Android shows a small "Ready for calls" notification while it
does; turning the setting off saves battery, but calls then only ring while
Tailchat is open.

## Also

* Camera, microphone and location requests from the page go through Android's
  permission prompts.
* Attaching a document opens the phone's own file picker. The app copies the
  file you pick and hands it to Tailchat, which encrypts and sends it as usual.
* Saving a file opens the share sheet, so you can keep it in Files or send it
  to another app. Big files are passed over in pieces.
* Copy buttons (addresses, theme codes) use the phone's clipboard.
* Links to other sites open in the browser.
* If the server can't be reached, the error screen lets you retry or change
  the address.

## How it fits together

The page talks to the Android side through `window.TailchatApp.post()`, set
up by the app's injected script, and the app answers with `tailchat-native`
events on `window` (`public/native.js` is the page's half). The page says
when a call rings, what the call is doing and when a message comes in; the
Android side (`CallCenter.kt`) decides how to show it: the pop-up
(`CallPopup.kt`), the lock screen (`IncomingCallActivity.kt`), notifications
(`Notices.kt`), the ringtone (`Ringer.kt`) and a foreground service
(`TailchatService.kt`). Answer, Decline, Reply and the rest come back to the
page as messages. `adb logcat -s TailchatCalls` shows how each call rang.

## Build

```sh
npm ci
npx expo start                                        # try it on a device or emulator
npx eas-cli build --platform android --profile apk    # APK on EAS (needs an expo.dev login)
```

The repository's **Android APK** workflow runs the EAS build and publishes the
APK as a GitHub release; see the main README. The **Android build check**
workflow builds the app from source on every change here, then runs it on an
Android emulator against a test server while a browser calls and messages it
(`e2e/emulator-test.cjs`), checking the pop-up, the lock screen, ringing,
notifications with Reply, the background call and picture in picture.
