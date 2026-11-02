package net.tailchat.calls

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.app.KeyguardManager
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.util.Rational
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.lang.ref.WeakReference
import kotlin.math.roundToInt

internal const val TAG = "TailchatCalls"

// The app's side of calls and notifications. Tailchat's page tells it what
// is going on (a call ringing, the call you're on, a new message) through
// the module, and it does what a web page can't: rings with the phone's
// ringtone, pops the call up over other apps or fills the lock screen, keeps
// the call going in the background, picture in picture, and notifications
// with Reply. What you press there goes back to the page.
//
// Everything runs on the main thread.
@SuppressLint("StaticFieldLeak") // only the application context is kept
internal object CallCenter {
  private val main = Handler(Looper.getMainLooper())
  private var app: Context? = null
  private var sink: ((String) -> Unit)? = null

  // The page has loaded and said hello; until then messages for it wait.
  private var pageReady = false
  private var pageSeen = false
  private val pending = ArrayList<JSONObject>()

  // The app's own activity, the one with the WebView.
  private var activity: WeakReference<Activity>? = null
  private var started = false
  private var resumed = false
  private var inPip = false
  private var fullScreenUp = false

  private val rings = LinkedHashMap<String, Ring>()
  private var ringer: Ringer? = null
  private var popup: CallPopup? = null
  private val ringNotes = HashSet<String>()

  @Volatile
  var call: CallInfo? = null
    private set
  private var connected = false
  private var overLock = false
  private var speaker: Boolean? = null
  private var proximity: PowerManager.WakeLock? = null

  // Answering waits for the app to be in front: Android only lets an app
  // use the microphone and camera from there.
  private var afterResume: JSONObject? = null

  private val chats = HashMap<String, ChatNote>()

  // ---------- setting up ----------

  fun ensure(context: Context) {
    if (app != null) return
    val ctx = context.applicationContext
    app = ctx
    try {
      Notices.createChannels(ctx)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't set up notification channels", e)
    }
    ringer = Ringer(ctx)
    popup = CallPopup(ctx)
    (ctx as? Application)?.registerActivityLifecycleCallbacks(lifecycle)
    val filter = IntentFilter()
    filter.addAction(Intent.ACTION_SCREEN_OFF)
    filter.addAction(Intent.ACTION_SCREEN_ON)
    filter.addAction(Intent.ACTION_USER_PRESENT)
    try {
      ContextCompat.registerReceiver(ctx, screen, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't watch the screen", e)
    }
  }

  // A new copy of the app's JavaScript started (the module was created).
  fun attach(context: Context, current: Activity?, send: (String) -> Unit) {
    ensure(context)
    sink = send
    pageReady = false
    if (current != null && isMain(current)) {
      use(current)
      handleIntent(current.intent)
    }
  }

  fun detach() {
    sink = null
    pageReady = false
  }

  // ---------- the page ----------

  fun fromPage(json: String) {
    main.post {
      try {
        handle(JSONObject(json))
      } catch (e: Exception) {
        Log.w(TAG, "a message from the page failed", e)
      }
    }
  }

  private fun handle(m: JSONObject) {
    val ctx = app ?: return
    when (m.optString("type")) {
      "hello" -> hello()
      "page-gone" -> pageReady = false
      "call-incoming" -> incoming(m)
      "call-incoming-end" -> incomingEnd(m)
      "call-state" -> callState(m)
      "pip" -> enterPip()
      "open-settings" -> openSettings(m.optString("what"))
      "keep-alive" -> setKeepAlive(m.optBoolean("on", true))
      "status" -> sendStatus()
      "notify" -> notifyMessage(m)
      "notify-clear" -> m.str("chatId")?.let { clearChat(ctx, it) }
      "audio-route" -> {
        speaker = m.optBoolean("speaker")
        applyRoute()
      }
    }
  }

  // The page loaded: a fresh start, so nothing it knew about before is ringing
  // or going on any more.
  private fun hello() {
    val ctx = app ?: return
    Log.i(TAG, "page ready")
    pageReady = true
    pageSeen = true
    for (id in rings.keys.toList()) dropRing(ctx, id)
    IncomingCallActivity.close(null)
    refreshRing()
    if (call != null) endCall()
    val waiting = ArrayList(pending)
    pending.clear()
    for (m in waiting) toPage(m)
    sendStatus()
    askForNotifications(false)
    TailchatService.sync(ctx)
  }

  internal fun toPage(m: JSONObject) {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      main.post { toPage(m) }
      return
    }
    val send = sink
    if (send == null || !pageReady) {
      pending.add(m)
      while (pending.size > 40) pending.removeAt(0)
      return
    }
    try {
      if (!intoWebView(m)) send(m.toString())
    } catch (e: Exception) {
      Log.w(TAG, "couldn't reach the page", e)
    }
  }

  // React Native hands messages to the page only while the app is on screen
  // (they wait for its next frame), so they go straight into the page's
  // WebView when there is one: Decline, Reply, Mute and Hang up then work
  // from the pop-up and the notifications while you use another app.
  private var web: WeakReference<WebView>? = null

  private fun intoWebView(m: JSONObject): Boolean {
    val view = webView() ?: return false
    // JSON is a JavaScript expression, apart from these two characters.
    val json = m.toString().replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    view.evaluateJavascript("window.dispatchEvent(new CustomEvent('tailchat-native', { detail: $json }));", null)
    return true
  }

  private fun webView(): WebView? {
    web?.get()?.takeIf { it.isAttachedToWindow }?.let { return it }
    val root = current()?.window?.peekDecorView() ?: return null
    val found = findWebView(root)
    web = found?.let { WeakReference(it) }
    return found
  }

  private fun findWebView(v: View): WebView? {
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }
    }
    return null
  }

  private val pageThere: Boolean get() = sink != null && pageReady

  private fun sendStatus() {
    val ctx = app ?: return
    val status = JSONObject()
      .put("overlay", Perms.overlay(ctx))
      .put("fullScreen", Perms.fullScreen(ctx))
      .put("notifications", Perms.notifications(ctx))
      .put("background", Prefs.keepAlive(ctx))
      .put("battery", Perms.battery(ctx))
      .put("pip", Perms.pip(ctx))
    toPage(JSONObject().put("type", "status").put("status", status))
  }

  fun callAction(action: String, callId: String) {
    if (!pageThere && (action == "hangup")) {
      // The page went away, and the call with it.
      endCall()
      return
    }
    toPage(JSONObject().put("type", "call-action").put("action", action).put("callId", callId))
  }

  // ---------- the activity ----------

  private fun isMain(a: Activity) = a !is IncomingCallActivity && a !is AnswerActivity

  private fun use(a: Activity) {
    if (activity?.get() !== a) activity = WeakReference(a)
  }

  private fun current(): Activity? = activity?.get()?.takeIf { !it.isFinishing && !it.isDestroyed }

  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
      if (isMain(activity)) use(activity)
    }

    override fun onActivityStarted(activity: Activity) {
      if (!isMain(activity)) return
      use(activity)
      started = true
      safely { refreshRing() }
    }

    override fun onActivityResumed(activity: Activity) {
      if (!isMain(activity)) return
      use(activity)
      started = true
      resumed = true
      safely { foreground(activity) }
    }

    override fun onActivityPaused(activity: Activity) {
      if (!isMain(activity)) return
      resumed = false
      safely { if (activity.isInPictureInPictureMode) setPip(true) }
    }

    override fun onActivityStopped(activity: Activity) {
      if (!isMain(activity) || activity !== this@CallCenter.activity?.get()) return
      started = false
      safely {
        setPip(false)
        refreshRing()
      }
    }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

    override fun onActivityDestroyed(activity: Activity) {
      if (this@CallCenter.activity?.get() !== activity) return
      this@CallCenter.activity = null
      started = false
      resumed = false
      safely { activityGone() }
    }
  }

  private fun safely(block: () -> Unit) {
    try {
      block()
    } catch (e: Exception) {
      Log.w(TAG, "call handling failed", e)
    }
  }

  // Expo's lifecycle hooks, as a second source: the module may be created
  // after the activity was already on screen.
  fun hostResumed(a: Activity?) {
    if (a == null || !isMain(a)) return
    use(a)
    if (resumed) return
    started = true
    resumed = true
    safely { foreground(a) }
  }

  fun intent(intent: Intent?) {
    safely { handleIntent(intent) }
  }

  // Runs on the main thread, where everything here happens.
  fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) safely(block) else main.post { safely(block) }
  }

  // Back in front: what may have changed in the phone's settings, a call
  // waiting to be answered, and the service with the microphone again.
  private fun foreground(a: Activity) {
    val ctx = app ?: return
    setPip(a.isInPictureInPictureMode)
    sendAfterResume()
    if (pageThere) sendStatus()
    refreshRing()
    applyWindow()
    TailchatService.sync(ctx)
  }

  private fun activityGone() {
    val ctx = app ?: return
    // The WebView goes with the activity, and any call with it.
    pageReady = false
    for (id in rings.keys.toList()) dropRing(ctx, id)
    refreshRing()
    if (call != null) endCall()
    TailchatService.sync(ctx)
  }

  // Swiped away from the recent apps.
  fun taskRemoved() {
    main.post { safely { activityGone() } }
  }

  // Taps on notifications open the app with what to do.
  private fun handleIntent(intent: Intent?) {
    if (intent == null) return
    val action = intent.getStringExtra(Notices.EXTRA_ACTION) ?: return
    val id = intent.getStringExtra(Notices.EXTRA_ID) ?: ""
    val video = intent.getBooleanExtra(Notices.EXTRA_VIDEO, false)
    val note = intent.getStringExtra(Notices.EXTRA_NOTE)
    intent.removeExtra(Notices.EXTRA_ACTION)
    val ctx = app ?: return
    when (action) {
      "open-chat" -> {
        clearChat(ctx, id)
        toPage(JSONObject().put("type", "open-chat").put("chatId", id))
      }
      "call-back" -> {
        if (note != null) Notices.cancel(ctx, note, Notices.ID_MISSED)
        toPage(JSONObject().put("type", "call-back").put("chatId", id).put("video", video))
      }
    }
  }

  private fun openApp(from: Context?) {
    val ctx = from ?: app ?: return
    val intent = Notices.openIntent(ctx) ?: return
    try {
      ctx.startActivity(intent)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't open Tailchat", e)
    }
  }

  // ---------- ringing ----------

  fun ring(callId: String): Ring? = rings[callId]

  private fun incoming(m: JSONObject) {
    val callId = m.str("callId") ?: return
    val ring = rings.getOrPut(callId) { Ring(callId) }
    ring.update(m)
    // A ring the page never ended (it crashed, or lost its connection) stops
    // on its own a little after the server would have given up.
    main.removeCallbacksAndMessages(ring)
    main.postAtTime({ if (rings[callId] === ring) safely { endRing(callId) } }, ring, SystemClock.uptimeMillis() + 75_000L)
    refreshRing()
    IncomingCallActivity.refresh()
  }

  private fun incomingEnd(m: JSONObject) {
    val ctx = app ?: return
    val callId = m.str("callId") ?: return
    val ring = rings[callId]
    endRing(callId)
    if (m.optBoolean("missed")) {
      val name = m.str("name") ?: ring?.name ?: "Tailchat"
      val text = m.str("text") ?: "Missed call"
      val chatId = m.str("chatId") ?: ring?.chatId ?: ""
      Notices.post(ctx, callId, Notices.ID_MISSED, Notices.missed(ctx, callId, chatId, name, text, ring?.video == true))
    }
  }

  private fun endRing(callId: String) {
    val ctx = app ?: return
    dropRing(ctx, callId)
    IncomingCallActivity.close(callId)
    refreshRing()
  }

  private fun dropRing(ctx: Context, callId: String) {
    rings.remove(callId)?.let { main.removeCallbacksAndMessages(it) }
    if (ringNotes.remove(callId)) Notices.cancel(ctx, callId, Notices.ID_INCOMING)
  }

  private fun locked(ctx: Context): Boolean {
    val keyguard = ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
    val power = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
    return keyguard?.isKeyguardLocked == true || power?.isInteractive == false
  }

  // Tailchat is on screen at full size, so its own ring screen shows.
  private fun inFront(ctx: Context) = started && !inPip && !locked(ctx)

  // Shows the newest ringing call the right way for where you are: nothing
  // extra while Tailchat is open, the pop-up over other apps, or Android's
  // call notification (full screen on the lock screen).
  private fun refreshRing() {
    val ctx = app ?: return
    val ring = rings.values.lastOrNull()
    for (id in ringNotes.toList()) {
      if (id != ring?.callId) {
        ringNotes.remove(id)
        Notices.cancel(ctx, id, Notices.ID_INCOMING)
      }
    }
    if (ring == null) {
      ringer?.stop()
      popup?.hide()
      shown(null)
      return
    }
    // Waiting calls beep in the call; the page plays that.
    if (ring.silenced || ring.waiting) ringer?.stop() else ringer?.start(ring.ringtone, ring.vibrate)
    val locked = locked(ctx)
    when {
      inFront(ctx) -> {
        popup?.hide()
        if (ringNotes.remove(ring.callId)) Notices.cancel(ctx, ring.callId, Notices.ID_INCOMING)
        shown("in the app")
      }
      !locked && fullScreenUp -> {
        popup?.hide()
        postRing(ctx, ring, Notices.RingStyle.QUIET)
        shown("full screen")
      }
      !locked && Perms.overlay(ctx) -> {
        if (ring.popupDismissed) popup?.hide() else popup?.show(ring)
        postRing(ctx, ring, Notices.RingStyle.QUIET)
        shown(if (popup?.showing == true) "pop-up" else "notification")
      }
      ring.silenced -> {
        popup?.hide()
        postRing(ctx, ring, Notices.RingStyle.SILENCED)
        shown("silenced notification")
      }
      else -> {
        popup?.hide()
        postRing(ctx, ring, Notices.RingStyle.LOUD)
        shown(if (locked) "call notification, locked" else "call notification")
        // Android 14 may not let the notification fill the lock screen, but
        // an app that may draw over other apps can open its screen itself.
        if (locked && !Perms.fullScreen(ctx) && Perms.overlay(ctx) && !IncomingCallActivity.showing) {
          IncomingCallActivity.start(ctx, ring.callId)
        }
      }
    }
  }

  // Where the ringing call shows, in the log when it changes.
  private var shownAs: String? = null

  private fun shown(how: String?) {
    if (how == shownAs) return
    shownAs = how
    Log.i(TAG, if (how == null) "ringing stopped" else "ringing: $how")
  }

  private fun postRing(ctx: Context, ring: Ring, style: Notices.RingStyle) {
    ringNotes.add(ring.callId)
    Notices.post(ctx, ring.callId, Notices.ID_INCOMING, Notices.incoming(ctx, ring, style))
  }

  // The power button silences a ringing call, as it does a phone call. The
  // pop-up and the lock screen keep the screen on while they ring, so the
  // screen going off while they show means the button was pressed.
  private val screen = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      safely {
        if (intent.action == Intent.ACTION_SCREEN_OFF && (popup?.showing == true || IncomingCallActivity.showing)) {
          for (r in rings.values) r.silenced = true
        }
        refreshRing()
      }
    }
  }

  fun fullScreenShown(on: Boolean) {
    fullScreenUp = on
    safely { refreshRing() }
  }

  fun popupDismissed(callId: String) {
    rings[callId]?.popupDismissed = true
    safely { refreshRing() }
  }

  fun openFromPopup(callId: String) {
    popup?.hide()
    rings[callId]?.popupDismissed = true
    openApp(null)
  }

  fun answer(from: Context?, callId: String, audioOnly: Boolean) {
    from?.let { ensure(it) }
    val ctx = app ?: return
    if (!rings.containsKey(callId) || !pageThere) {
      // Nothing here to answer any more: open Tailchat to see what happened.
      endRing(callId)
      openApp(from)
      return
    }
    Log.i(TAG, "answering")
    endRing(callId)
    if (locked(ctx)) {
      overLock = true
      setOverLock(true)
    }
    afterResume = JSONObject().put("type", "call-action").put("action", if (audioOnly) "accept-audio" else "accept").put("callId", callId)
    if (resumed && !inPip) {
      sendAfterResume()
    } else {
      openApp(from)
      // In case the app never comes to the front (Android said no).
      main.postDelayed({ sendAfterResume() }, 3000)
    }
  }

  private fun sendAfterResume() {
    val m = afterResume ?: return
    afterResume = null
    toPage(m)
  }

  fun decline(callId: String) {
    endRing(callId)
    toPage(JSONObject().put("type", "call-action").put("action", "decline").put("callId", callId))
  }

  // ---------- the call you're on ----------

  private fun callState(m: JSONObject) {
    val ctx = app ?: return
    if (!m.optBoolean("active")) {
      endCall()
      return
    }
    val next = CallInfo(m)
    val before = call
    call = next
    if (before == null || before.status != next.status || before.video != next.video) {
      Log.i(TAG, "call: ${next.status}${if (next.video) ", video" else ""}")
    }
    if (before == null || before.callId != next.callId) {
      speaker = null
      connected = false
    }
    if (rings.containsKey(next.callId)) endRing(next.callId)
    if (next.status == "active" && !connected) {
      connected = true
      applyRoute()
    } else if (before != null && before.video != next.video && speaker == null) {
      applyRoute()
    }
    applyWindow()
    TailchatService.sync(ctx)
  }

  private fun endCall() {
    val ctx = app ?: return
    if (call != null) Log.i(TAG, "call: ended")
    val wasInPip = inPip
    call = null
    connected = false
    speaker = null
    afterResume = null
    releaseRoute(ctx)
    applyWindow()
    if (overLock) {
      overLock = false
      setOverLock(false)
    }
    TailchatService.sync(ctx)
    // The small window has nothing left to show.
    if (wasInPip) main.postDelayed({ if (call == null && inPip) current()?.moveTaskToBack(true) }, 1500)
  }

  fun wantsService(): Boolean {
    val ctx = app ?: return false
    return call != null || (Prefs.keepAlive(ctx) && pageSeen && current() != null)
  }

  fun setKeepAlive(on: Boolean) {
    val ctx = app ?: return
    Prefs.setKeepAlive(ctx, on)
    TailchatService.sync(ctx)
    sendStatus()
  }

  // Over the lock screen only for a call answered there, and only until it ends.
  @Suppress("DEPRECATION")
  private fun setOverLock(on: Boolean) {
    val a = current() ?: return
    try {
      if (Build.VERSION.SDK_INT >= 27) {
        a.setShowWhenLocked(on)
      } else if (on) {
        a.window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
      } else {
        a.window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
      }
    } catch (e: Exception) {
      Log.w(TAG, "couldn't show over the lock screen", e)
    }
  }

  // Screen on during video calls, and picture in picture with Mute and Hang up.
  private fun applyWindow() {
    val ctx = app ?: return
    val a = current() ?: return
    val c = call
    try {
      if (c != null && c.video) {
        a.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } else {
        a.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    } catch (e: Exception) {
      Log.w(TAG, "couldn't keep the screen on", e)
    }
    if (Build.VERSION.SDK_INT >= 26 && Perms.pip(ctx)) {
      try {
        a.setPictureInPictureParams(pipParams(ctx))
      } catch (e: Exception) {
        Log.w(TAG, "couldn't set up picture in picture", e)
      }
    }
  }

  private fun pipParams(ctx: Context): PictureInPictureParams {
    val c = call
    val builder = PictureInPictureParams.Builder()
    val shape = when {
      c != null && c.aspect > 0 -> c.aspect
      c != null && c.video -> 9.0 / 16.0
      else -> 1.0
    }.coerceIn(0.42, 2.38)
    builder.setAspectRatio(Rational((shape * 1000).roundToInt(), 1000))
    if (c != null) {
      val muteAction = if (c.muted) ActionReceiver.UNMUTE else ActionReceiver.MUTE
      val mute = RemoteAction(
        Icon.createWithResource(ctx, if (c.muted) R.drawable.tailchat_mic_off else R.drawable.tailchat_mic),
        if (c.muted) "Unmute" else "Mute",
        if (c.muted) "Unmute" else "Mute",
        Notices.actionPending(ctx, muteAction, c.callId),
      )
      val hangup = RemoteAction(
        Icon.createWithResource(ctx, R.drawable.tailchat_call_end),
        "Hang up",
        "Hang up",
        Notices.actionPending(ctx, ActionReceiver.HANGUP, c.callId),
      )
      builder.setActions(listOf(mute, hangup))
    } else {
      builder.setActions(emptyList())
    }
    if (Build.VERSION.SDK_INT >= 31) {
      // Leaving the app in a video call carries it on in a small window.
      builder.setAutoEnterEnabled(c != null && c.video)
      builder.setSeamlessResizeEnabled(true)
    }
    return builder.build()
  }

  private fun enterPip() {
    val ctx = app ?: return
    val a = current() ?: return
    if (Build.VERSION.SDK_INT < 26 || !Perms.pip(ctx)) {
      toPage(JSONObject().put("type", "pip").put("on", false).put("error", "Picture in picture is turned off for Tailchat in your phone's settings"))
      return
    }
    try {
      if (!a.enterPictureInPictureMode(pipParams(ctx))) toPage(JSONObject().put("type", "pip").put("on", false))
    } catch (e: Exception) {
      Log.w(TAG, "couldn't go into picture in picture", e)
      toPage(JSONObject().put("type", "pip").put("on", false).put("error", "This phone can't show the call in a small window"))
    }
  }

  // Android 8 to 11: going home in a video call goes into picture in picture
  // (later versions do it on their own, see setAutoEnterEnabled).
  fun userLeaving() {
    val ctx = app ?: return
    val c = call ?: return
    if (Build.VERSION.SDK_INT !in 26..30 || !c.video || !Perms.pip(ctx)) return
    val a = current() ?: return
    safely { a.enterPictureInPictureMode(pipParams(ctx)) }
  }

  private fun setPip(on: Boolean) {
    if (inPip == on) return
    inPip = on
    Log.i(TAG, "picture in picture ${if (on) "on" else "off"}")
    toPage(JSONObject().put("type", "pip").put("on", on))
    refreshRing()
  }

  // ---------- speaker or earpiece ----------

  private val externalTypes = setOf(
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_HEARING_AID,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
  )

  private fun external(audio: AudioManager): Boolean = try {
    audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in externalTypes }
  } catch (e: Exception) {
    false
  }

  // Video calls on the speaker, voice calls at your ear (with the screen
  // going off against your face), and headphones whenever they're plugged in
  // or connected. The Speaker button in the call changes it.
  @Suppress("DEPRECATION")
  private fun applyRoute() {
    val ctx = app ?: return
    val c = call ?: return
    val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val headset = external(audio)
    val onSpeaker = speaker ?: (c.video && !headset)
    try {
      if (Build.VERSION.SDK_INT >= 31) {
        val devices = audio.availableCommunicationDevices
        val target = when {
          onSpeaker -> devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
          headset -> null
          else -> devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
        }
        if (target != null) audio.setCommunicationDevice(target) else audio.clearCommunicationDevice()
      } else {
        audio.isSpeakerphoneOn = onSpeaker
      }
    } catch (e: Exception) {
      Log.w(TAG, "couldn't change the speaker", e)
    }
    proximityLock(!onSpeaker && !headset && !c.video)
    toPage(JSONObject().put("type", "audio-route").put("speaker", onSpeaker).put("headset", headset))
  }

  @Suppress("DEPRECATION")
  private fun releaseRoute(ctx: Context) {
    proximityLock(false)
    val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    try {
      if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else audio.isSpeakerphoneOn = false
    } catch (e: Exception) {
      Log.w(TAG, "couldn't reset the speaker", e)
    }
  }

  private fun proximityLock(on: Boolean) {
    val ctx = app ?: return
    if (on) {
      if (proximity?.isHeld == true) return
      val power = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
      if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
      try {
        val lock = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "tailchat:call")
        lock.setReferenceCounted(false)
        lock.acquire(6 * 60 * 60 * 1000L)
        proximity = lock
      } catch (e: Exception) {
        Log.w(TAG, "couldn't use the proximity sensor", e)
      }
    } else {
      val lock = proximity ?: return
      proximity = null
      try {
        if (lock.isHeld) lock.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
      } catch (e: Exception) {
        Log.w(TAG, "couldn't let go of the proximity sensor", e)
      }
    }
  }

  // ---------- settings ----------

  private fun askForNotifications(always: Boolean) {
    val ctx = app ?: return
    if (Build.VERSION.SDK_INT < 33 || Perms.notifications(ctx)) return
    if (!always && Prefs.askedNotifications(ctx)) return
    val a = current() ?: return
    if (!resumed) return
    Prefs.setAskedNotifications(ctx)
    try {
      ActivityCompat.requestPermissions(a, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7310)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't ask for notifications", e)
    }
  }

  @SuppressLint("BatteryLife")
  private fun openSettings(what: String) {
    val ctx = app ?: return
    val pkg = Uri.parse("package:" + ctx.packageName)
    val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
    val intent = when (what) {
      "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg)
      "full-screen" -> if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else details
      "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
      "pip" -> Intent("android.settings.PICTURE_IN_PICTURE_SETTINGS")
      "notifications" -> {
        if (Build.VERSION.SDK_INT >= 33 && !Perms.notifications(ctx) && !Prefs.askedNotifications(ctx)) {
          askForNotifications(true)
          return
        }
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
      }
      else -> details
    }
    if (!startSettings(intent)) startSettings(details)
  }

  private fun startSettings(intent: Intent): Boolean {
    val a = current()
    return try {
      if (a != null) a.startActivity(intent) else app?.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    } catch (e: Exception) {
      false
    }
  }

  // ---------- messages ----------

  private fun notifyMessage(m: JSONObject) {
    val ctx = app ?: return
    val chatId = m.str("chatId") ?: return
    val note = chats.getOrPut(chatId) { ChatNote(chatId) }
    m.str("title")?.let { note.title = it.take(80) }
    note.group = m.optBoolean("group", note.group)
    val line = Line(
      sender = (m.str("sender") ?: note.title).take(80),
      senderKey = m.str("senderId"),
      text = (m.str("text") ?: "New message").take(600),
      at = m.optLong("at", System.currentTimeMillis()),
      color = m.str("color"),
      initials = m.str("initials") ?: "?",
      photo = m.str("photo"),
    )
    note.lines.add(line)
    while (note.lines.size > 7) note.lines.removeAt(0)
    note.count++
    Notices.post(ctx, chatId, Notices.ID_MESSAGE, Notices.message(ctx, note))
    Log.i(TAG, "message notification")
  }

  private fun clearChat(ctx: Context, chatId: String) {
    chats.remove(chatId)
    Notices.cancel(ctx, chatId, Notices.ID_MESSAGE)
  }

  fun markRead(chatId: String) {
    val ctx = app ?: return
    clearChat(ctx, chatId)
    toPage(JSONObject().put("type", "mark-read").put("chatId", chatId))
  }

  fun reply(chatId: String, text: String) {
    val ctx = app ?: return
    Log.i(TAG, "reply from a notification")
    if (!pageThere) {
      Toast.makeText(ctx, "Open Tailchat to reply", Toast.LENGTH_SHORT).show()
      chats[chatId]?.let { Notices.post(ctx, chatId, Notices.ID_MESSAGE, Notices.message(ctx, it)) }
      return
    }
    clearChat(ctx, chatId)
    toPage(JSONObject().put("type", "reply").put("chatId", chatId).put("text", text))
  }

  fun chatDismissed(chatId: String) {
    chats.remove(chatId)
  }
}
