# Tailchat for Android

An Expo app that runs Tailchat's web app in a WebView. The first screen asks
for your server's address (for example `https://tailchat.your-tailnet.ts.net`)
and remembers it. The phone must be connected to your tailnet with the
Tailscale app.

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

## Build

```sh
npm ci
npx expo start                                        # try it on a device or emulator
npx eas-cli build --platform android --profile apk    # APK on EAS (needs an expo.dev login)
```

The repository's **Android APK** workflow runs the EAS build and publishes the
APK as a GitHub release; see the main README.
