package net.tailchat.calls

import android.Manifest
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

// Keeps Tailchat running while it isn't on screen: during a call (with the
// microphone and camera, and Hang up and Mute in its notification), and
// while it stays connected so calls ring and messages arrive.
class TailchatService : Service() {
  companion object {
    @Volatile
    private var instance: TailchatService? = null
    private var starting = false

    // Starts, updates or stops the service to match what's going on.
    fun sync(context: Context) {
      val want = CallCenter.wantsService()
      val running = instance
      if (running != null) {
        if (want) running.show() else running.finish()
        return
      }
      if (!want || starting) return
      try {
        starting = true
        ContextCompat.startForegroundService(context, Intent(context, TailchatService::class.java))
      } catch (e: Exception) {
        // Android only lets an app start this from the front; it's tried
        // again when Tailchat comes back to the front.
        starting = false
        Log.w(TAG, "couldn't start the background service", e)
      }
    }
  }

  private var types = -1
  private var shown: String? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    instance = this
    starting = false
    // Android stops an app that doesn't call startForeground in time, so it
    // always does, even when there's nothing left to show.
    show()
    if (!CallCenter.wantsService()) finish()
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // Swiped away from the recent apps: the page, and any call, go with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
    CallCenter.taskRemoved()
    finish()
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    starting = false
    super.onDestroy()
  }

  fun show() {
    val call = CallCenter.call
    val notification = if (call != null) Notices.ongoing(this, call) else Notices.standby(this)
    val want = if (call != null) callTypes(call) else standbyType()
    val kind = if (call != null) "call" else "standby"
    if (types == want && shown == kind) {
      // Only the notification changed: no need to ask Android again.
      Notices.post(this, null, Notices.ID_SERVICE, notification)
      return
    }
    if (goForeground(notification, want)) {
      shown = kind
      return
    }
    // The microphone and camera are only allowed from the front: carry on
    // without them for now, and ask again when Tailchat is back in front.
    val fallback = standbyType()
    if (want != fallback && goForeground(notification, fallback)) {
      shown = kind
      return
    }
    finish()
  }

  private fun goForeground(notification: Notification, foregroundTypes: Int): Boolean = try {
    ServiceCompat.startForeground(this, Notices.ID_SERVICE, notification, foregroundTypes)
    types = foregroundTypes
    true
  } catch (e: Exception) {
    Log.w(TAG, "couldn't keep running in the background", e)
    false
  }

  private fun callTypes(call: CallInfo): Int {
    if (Build.VERSION.SDK_INT < 30) return 0
    var t = 0
    if (Perms.granted(this, Manifest.permission.RECORD_AUDIO)) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    if (call.video && !call.cameraOff && Perms.granted(this, Manifest.permission.CAMERA)) t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    return if (t != 0) t else standbyType()
  }

  private fun standbyType(): Int =
    if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0

  fun finish() {
    // A new start from here on starts it again rather than talking to this one.
    if (instance === this) instance = null
    try {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't leave the foreground", e)
    }
    types = -1
    shown = null
    stopSelf()
  }
}
