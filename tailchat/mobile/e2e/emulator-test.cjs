// Runs the Tailchat Android app on an emulator against a local dev server
// and checks what only a phone can show: calls popping up over other apps
// and filling the lock screen, the phone ringing, message notifications with
// Reply, the call carrying on in the background, and picture in picture.
// Dana calls and messages the phone from a browser on the same machine.
//
// Needs one emulator on adb with the app installed, the dev server on
// 127.0.0.1:8099 and tls-proxy.cjs on 127.0.0.1:8443 (adb reverse makes it
// https://localhost:8443 on the phone), and Playwright on NODE_PATH.
// Screenshots go to $OUT, and are printed into the log as small JPEGs
// between "@@SHOT" lines.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const PKG = 'net.tailchat.app';
const BASE = 'http://127.0.0.1:8099';
const OUT = process.env.OUT || 'e2e-out';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const shots = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(...args) {
  try {
    return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 60000 });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}
const shell = (cmd) => adb('shell', cmd);

// why() runs when a check fails, to print what the phone showed instead.
function check(ok, what, detail = '', why = null) {
  results.push({ ok: !!ok, what });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `  [${detail}]` : ''}`);
  if (!ok && why) {
    try {
      console.log(`  ${String(why()).trim().split('\n').slice(0, 60).join('\n  ')}`);
    } catch (e) {
      console.log(`  (couldn't explain: ${e.message})`);
    }
  }
  return !!ok;
}

// What's on screen, as text, for a failed check.
const onScreen = () => `on screen: ${views().map((v) => v.text || v.desc).filter(Boolean).join(' | ')}\nresumed: ${resumed()}`;
const tailchatWindows = () => shell(`dumpsys window windows | grep -A 40 'u0 ${PKG}'`);
const tailchatNotes = () => shell(`dumpsys notification --noredact | grep -B 2 -A 40 'pkg=${PKG}' | head -150`);

async function until(fn, timeout = 30000, every = 500) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

function shot(name) {
  try {
    const png = execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20, timeout: 30000 });
    const file = path.join(OUT, `${String(shots.length + 1).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(file, png);
    shots.push({ name, file });
  } catch (e) {
    console.log(`couldn't take the ${name} screenshot: ${e.message}`);
  }
}

// ---------- what the phone shows ----------

// Tailchat's lines in the log since the test started.
const logs = () => adb('logcat', '-d', '-s', 'TailchatCalls:I');
const logged = (re) => re.test(logs());

// Tailchat's notifications: channel, title, text, template and actions.
function notifications() {
  // Only the notifications showing now, not the history after them.
  let out = shell('dumpsys notification --noredact');
  const from = out.indexOf('Notification List:');
  if (from >= 0) out = out.slice(from);
  const to = out.search(/\n {2}\S/);
  if (to > 0) out = out.slice(0, to);
  const list = [];
  for (const rec of out.split(/\n\s+NotificationRecord\(/).slice(1)) {
    if (!rec.includes(`pkg=${PKG}`)) continue;
    const body = rec.split(/\n\s+NotificationRecord\(|\n\s{2}\S/)[0];
    const grab = (re) => re.exec(body)?.[1] ?? null;
    list.push({
      id: grab(/ id=(\d+)/),
      tag: grab(/ tag=(\S+)/),
      channel: grab(/channel=([\w.-]+)/),
      title: grab(/android\.title=\w+ \((.*)\)/),
      text: grab(/android\.text=\w+ \((.*)\)/),
      template: grab(/android\.template=\w+ \(([\w.$]+)\)/),
      fullScreen: /fullscreenIntent=PendingIntent/.test(body),
      actions: [...body.matchAll(/\[\d+\] "([^"]*)" ->/g)].map((m) => m[1]),
    });
  }
  return list;
}
const note = (channel) => notifications().find((n) => n.channel === channel) || null;

// The views in the window in front, from uiautomator. A slow emulator
// sometimes says another app "isn't responding": that dialog is waved away
// with Wait, since it would cover everything else.
function views(again = 2) {
  shell('uiautomator dump /sdcard/tc-ui.xml');
  const xml = shell('cat /sdcard/tc-ui.xml');
  const list = (xml.match(/<node [^>]*>/g) || []).map((n) => {
    const attr = (k) => new RegExp(`${k}="([^"]*)"`).exec(n)?.[1] || '';
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
    return { text: attr('text'), desc: attr('content-desc'), cls: attr('class'), pkg: attr('package'), x: b ? (+b[1] + +b[3]) >> 1 : 0, y: b ? (+b[2] + +b[4]) >> 1 : 0 };
  });
  const anr = list.find((v) => /isn.t responding/.test(v.text));
  const wait = anr && list.find((v) => v.text === 'Wait');
  if (wait && again > 0) {
    console.log(`(waving away "${anr.text}")`);
    shell(`input tap ${wait.x} ${wait.y}`);
    execFileSync('sleep', ['1']);
    return views(again - 1);
  }
  return list;
}
async function tap(match, timeout = 15000) {
  const v = await until(() => views().find(match), timeout, 1000);
  if (v) shell(`input tap ${v.x} ${v.y}`);
  return v;
}

// The call pop-up's window, if it shows: its frame on screen.
function popupFrame() {
  const out = shell('dumpsys window windows');
  for (const block of out.split(/\n\s*Window #\d+ /).slice(1)) {
    if (!block.includes(PKG) || !/ty=APPLICATION_OVERLAY/.test(block)) continue;
    const f = /(?:^|\s)(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/m.exec(block);
    return f ? { l: +f[1], t: +f[2], r: +f[3], b: +f[4] } : { unknown: true };
  }
  return null;
}

const activities = () => shell('dumpsys activity activities');
function resumed() {
  const out = activities();
  return /(?:topResumedActivity|mResumedActivity)[=:]\s*ActivityRecord\{\S+ u\d+ (\S+)/.exec(out)?.[1] || '';
}
const pinned = () => shell('dumpsys activity activities | grep -A 4 "mode=pinned"').includes(PKG);
const ringtonePlaying = () => /state:started[^\n]*USAGE_NOTIFICATION_RINGTONE|USAGE_NOTIFICATION_RINGTONE[^\n]*state:started/.test(shell('dumpsys audio'));
const awake = () => /mWakefulness=Awake/.test(shell('dumpsys power'));
const keyguard = () => /isKeyguardShowing=true|mShowing=true/.test(shell('dumpsys window policy') + shell('dumpsys activity activities | grep -i keyguard'));

function density() {
  const m = /(\d+)\s*$/.exec(shell('wm density').trim().split('\n').pop() || '');
  return m ? Number(m[1]) / 160 : 2.75;
}

// The screenshots, small, into the log (the test's artifacts can't always
// be fetched).
async function printShots() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 300, height: 300 }, deviceScaleFactor: 1 });
  for (const s of shots) {
    const png = fs.readFileSync(s.file).toString('base64');
    await page.setContent(`<body style="margin:0"><img id="i" style="display:block;width:300px" src="data:image/png;base64,${png}"></body>`);
    await page.waitForFunction(() => document.getElementById('i').complete);
    const jpg = (await page.locator('#i').screenshot({ type: 'jpeg', quality: 55 })).toString('base64');
    const parts = jpg.match(/.{1,3000}/g);
    parts.forEach((p, i) => console.log(`@@SHOT ${s.name} ${i + 1}/${parts.length} ${p}`));
  }
  await browser.close();
}

// ---------- the test ----------

(async () => {
  const dp = density();
  console.log(`screen: ${shell('wm size').trim()}, density ${dp}`);
  adb('logcat', '-c');

  // Tailchat, pointed at the test server.
  shell(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  const field = await until(() => views().find((v) => v.cls === 'android.widget.EditText'), 60000, 1500);
  if (check(field, 'the app opens on its server address screen')) {
    shell(`input tap ${field.x} ${field.y}`);
    await sleep(500);
    shell('input text localhost:8443');
    shell('input keyevent 66');
  }
  const ready = await until(() => logged(/page ready/), 120000, 2000);
  if (!check(ready, 'Tailchat loads in the app and talks to the Android side', '', () => `${onScreen()}\n${logs()}`)) {
    shot('not-loaded');
    await printShots();
    console.log('\nstopping: the rest needs Tailchat loaded in the app');
    process.exit(1);
  }
  await sleep(4000);
  shot('chats');
  check(note('tailchat_connection'), 'it stays connected in the background, with a small notification', JSON.stringify(notifications().map((n) => n.channel)), tailchatNotes);

  // Dana, in a browser on the computer.
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 780 } });
  await ctx.grantPermissions(['camera', 'microphone'], { origin: BASE });
  const dana = await ctx.newPage();
  dana.on('pageerror', (e) => console.log('Dana page error:', e.message));
  await dana.goto(`${BASE}/dev/login?user=dana`);
  await dana.waitForSelector('.rail, .tabs, .chats', { timeout: 30000 });
  const chatId = await dana.evaluate(async () => (await (await import('/app.js')).openDirect('malcolm@dev')).id);
  const dcall = (fn, arg) => dana.evaluate(fn, arg);
  const callStatus = () => dcall(() => import('/app.js').then((m) => m.calls.call?.status || null));
  const startCall = (video) => dcall(([id, v]) => Promise.all([import('/app.js'), import('/callscreen.js')]).then(([a, c]) => c.startCall(a.S.chats.get(id), v)), [chatId, video]);
  const hangUp = () => dcall(() => import('/app.js').then((m) => m.calls.call && m.calls.hangup()));
  const say = (text) => dcall(([id, t]) => import('/app.js').then((m) => m.sendText(id, t)), [chatId, text]);
  const lastFromMalcolm = () => dcall((id) => import('/app.js').then((m) => {
    const list = m.S.msgs.get(id)?.list || [];
    const mine = list.filter((x) => x.senderId === 'malcolm@dev');
    const c = mine.length ? m.contentOf(mine[mine.length - 1])?.ok : null;
    return c?.text || null;
  }), chatId);
  await dcall((id) => import('/app.js').then((m) => m.openChat(id)), chatId);

  // ---- a message pops up while you use another app ----
  shell('input keyevent KEYCODE_HOME');
  await sleep(2500);
  await say('Hello from Dana');
  const msg = await until(() => note('tailchat_messages'), 30000, 1000);
  await sleep(600);
  shot('message-pops-up');
  check(msg && /Dana/.test(`${msg.title} ${msg.text}`) && /Hello from Dana/.test(JSON.stringify(msg)), 'a new message pops up with who sent it and what they said', JSON.stringify(msg), tailchatNotes);
  check(msg && msg.template?.includes('MessagingStyle') && msg.actions.includes('Reply') && msg.actions.includes('Mark as read'), 'it has Reply and Mark as read', JSON.stringify(msg?.actions));

  // Reply from the notification.
  shell('cmd statusbar expand-notifications');
  await sleep(1500);
  const replyButton = await tap((v) => v.text === 'Reply' || v.desc === 'Reply', 10000);
  if (replyButton) {
    await sleep(1200);
    shell('input text "On%smy%sway"');
    await sleep(500);
    shot('replying');
    const send = views().find((v) => /send/i.test(v.desc));
    if (send) shell(`input tap ${send.x} ${send.y}`);
    else shell('input keyevent 66');
  }
  const replied = await until(() => lastFromMalcolm().then((t) => t === 'On my way'), 30000, 1000);
  check(replied, 'Reply in the notification sends the message', `last from Malcolm: ${await lastFromMalcolm()}`, () => `${onScreen()}\n${logs()}`);
  await sleep(1000);
  check(!note('tailchat_messages'), 'and clears the notification');
  shell('cmd statusbar collapse');
  await sleep(1000);

  // ---- a call pops up over other apps ----
  shell('input keyevent KEYCODE_HOME');
  await sleep(1500);
  await startCall(true);
  const frame = await until(() => popupFrame(), 30000, 1000);
  await sleep(800);
  shot('call-pops-up');
  check(frame, 'an incoming call pops up at the top of the screen, over other apps', JSON.stringify(frame), () => `${tailchatWindows()}\n${logs()}`);
  check(logged(/ringing: pop-up/), 'Tailchat chose the pop-up');
  check(resumed().includes('launcher') || !resumed().includes(PKG), "it doesn't take over the screen", resumed());
  const quiet = note('tailchat_calls_quiet');
  check(quiet && quiet.actions.includes('Answer') && quiet.actions.includes('Decline'), 'the call is in the notifications too, with Answer and Decline', JSON.stringify(quiet));
  check(await until(() => ringtonePlaying(), 5000, 500), 'the phone rings with its ringtone');

  // Answer on the pop-up.
  if (frame && !frame.unknown) {
    const cardTop = frame.t + 4 * dp;
    const cardBottom = frame.b - 14 * dp;
    const y = Math.round((cardTop + cardBottom) / 2);
    const x = Math.round(frame.r - (6 + 12 + 24) * dp);
    shell(`input tap ${x} ${y}`);
  } else {
    shell('cmd statusbar expand-notifications');
    await sleep(1500);
    await tap((v) => v.text === 'Answer' || v.desc === 'Answer');
  }
  const answered = await until(() => logged(/answering/), 10000, 500);
  check(answered, 'Answer on the pop-up answers', '', () => `${tailchatWindows()}\n${logs()}`);
  const front = await until(() => resumed().includes(PKG), 10000, 500);
  check(front, 'and opens Tailchat', resumed());
  check(await until(() => !popupFrame(), 5000, 500), 'the pop-up goes away');
  check(await until(() => !ringtonePlaying(), 5000, 500), 'the ringing stops');
  const active = await until(() => callStatus().then((s) => s === 'active'), 45000, 1000);
  check(await until(() => logged(/call: active/), 20000, 1000), 'the app sees the call connect');
  await sleep(4000);
  shot('in-the-call');
  check(active, 'the call connects', `Dana's call: ${await callStatus()}`, () => `${onScreen()}\n${logs()}`);
  const ongoing = await until(() => note('tailchat_ongoing'), 10000, 1000);
  check(ongoing && ongoing.actions.some((a) => /Hang up/i.test(a)), 'an ongoing call notification with Hang up keeps the call going in the background', JSON.stringify(ongoing));

  // ---- picture in picture ----
  shell('input keyevent KEYCODE_HOME');
  const pip = await until(() => logged(/picture in picture on/), 15000, 1000);
  await sleep(4000);
  shot('picture-in-picture');
  check(pip, 'going home during a video call carries it on in picture in picture', `pinned in dumpsys: ${pinned()}`, () => `${shell('dumpsys activity activities | grep -i -B 2 -A 6 pinned | head -40')}\n${logs()}`);
  check(await callStatus() === 'active', 'the call stays connected meanwhile');
  await sleep(4000);
  shot('picture-in-picture-later');

  // Dana hangs up.
  await hangUp();
  check(await until(() => logged(/call: ended/), 15000, 1000), 'the app hears when the call ends');
  await sleep(3000);
  check(!note('tailchat_ongoing'), 'the ongoing call notification goes away');
  check(!logged(/picture in picture on/) || await until(() => logged(/picture in picture off/), 8000, 1000), 'the small window closes');
  shot('after-the-call');

  // ---- Decline on the pop-up ----
  shell('input keyevent KEYCODE_HOME');
  await sleep(2000);
  adb('logcat', '-c');
  await startCall(false);
  const frame2 = await until(() => popupFrame(), 30000, 1000);
  await sleep(600);
  if (frame2 && !frame2.unknown) {
    const y = Math.round((frame2.t + 4 * dp + frame2.b - 14 * dp) / 2);
    const x = Math.round(frame2.r - (6 + 12 + 24 + 24 + 10 + 24) * dp);
    shell(`input tap ${x} ${y}`);
  }
  const declined = await until(() => callStatus().then((s) => s === null || s === 'ended' || s === 'declined'), 15000, 1000);
  check(frame2 && declined, 'Decline on the pop-up declines the call', `Dana's call: ${await callStatus()}`);
  check(await until(() => !popupFrame(), 5000, 500), 'and the pop-up goes away');
  await hangUp();
  await sleep(3000);

  // ---- a call on the lock screen ----
  adb('logcat', '-c');
  shell('input keyevent KEYCODE_SLEEP');
  await sleep(3000);
  await startCall(false);
  const full = await until(() => resumed().includes('IncomingCallActivity'), 30000, 1000);
  await sleep(1500);
  shot('lock-screen-call');
  check(full, 'on the lock screen an incoming call fills the screen', resumed(), () => `${tailchatNotes()}\n${logs()}`);
  check(awake(), 'and turns the screen on');
  check(logged(/ringing: call notification, locked/), 'with the call notification behind it', JSON.stringify(note('tailchat_calls')));
  check(await until(() => ringtonePlaying(), 5000, 500), 'the phone rings');

  // Dana gives up: a missed call.
  await sleep(2000);
  await hangUp();
  const missed = await until(() => note('tailchat_missed'), 15000, 1000);
  check(missed && missed.actions.includes('Call back'), 'a call you missed leaves a notification with Call back', JSON.stringify(missed));
  check(await until(() => !resumed().includes('IncomingCallActivity'), 8000, 1000), 'and the call screen closes', resumed());
  check(await until(() => !ringtonePlaying(), 5000, 500), 'and the ringing stops');
  shot('missed-call');

  // ---- with Tailchat open, its own ring screen shows ----
  shell('input keyevent KEYCODE_WAKEUP');
  shell('wm dismiss-keyguard');
  await sleep(1500);
  shell(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  await sleep(3000);
  adb('logcat', '-c');
  await startCall(true);
  const inApp = await until(() => logged(/ringing: in the app/), 30000, 1000);
  await sleep(1200);
  shot('ringing-in-the-app');
  check(inApp && !popupFrame(), 'with Tailchat open, its own ring screen shows instead of the pop-up');
  await hangUp();
  await sleep(2000);

  // ---- nothing crashed ----
  const crashes = adb('logcat', '-d', '-b', 'crash');
  check(!crashes.includes(PKG), 'the app never crashed', crashes.split('\n').slice(0, 12).join(' | '));
  console.log('\n---- Tailchat log ----');
  console.log(adb('logcat', '-d', '-s', 'TailchatCalls:*').split('\n').slice(-80).join('\n'));

  await browser.close();
  await printShots();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
  for (const f of failed) console.log(`  failed: ${f.what}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('the test crashed:', e);
  process.exit(2);
});
