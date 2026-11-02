package net.tailchat.calls

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.core.app.RemoteInput

// Buttons in notifications and in the picture-in-picture window that don't
// need the app on screen: Decline, Hang up, Mute, Reply, Mark as read.
class ActionReceiver : BroadcastReceiver() {
  companion object {
    const val DECLINE = "net.tailchat.calls.DECLINE"
    const val HANGUP = "net.tailchat.calls.HANGUP"
    const val MUTE = "net.tailchat.calls.MUTE"
    const val UNMUTE = "net.tailchat.calls.UNMUTE"
    const val READ = "net.tailchat.calls.READ"
    const val REPLY = "net.tailchat.calls.REPLY"
    const val DISMISSED = "net.tailchat.calls.DISMISSED"
    const val STANDBY_OFF = "net.tailchat.calls.STANDBY_OFF"
  }

  override fun onReceive(context: Context, intent: Intent) {
    CallCenter.ensure(context)
    val id = intent.getStringExtra(Notices.EXTRA_ID) ?: ""
    when (intent.action) {
      DECLINE -> CallCenter.decline(id)
      HANGUP -> CallCenter.callAction("hangup", id)
      MUTE -> CallCenter.callAction("mute", id)
      UNMUTE -> CallCenter.callAction("unmute", id)
      READ -> CallCenter.markRead(id)
      REPLY -> {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notices.KEY_REPLY)?.toString()?.trim()
        if (!text.isNullOrEmpty()) CallCenter.reply(id, text)
      }
      DISMISSED -> CallCenter.chatDismissed(id)
      STANDBY_OFF -> CallCenter.setKeepAlive(false)
    }
  }
}

// Answer in a notification. It shows over the lock screen for a moment,
// hands the call to Tailchat and closes, so answering doesn't wait for the
// phone to be unlocked.
class AnswerActivity : Activity() {
  companion object {
    const val EXTRA_AUDIO_ONLY = "net.tailchat.calls.audioOnly"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    showOverLockScreen(this, turnScreenOn = false)
    CallCenter.ensure(this)
    val callId = intent?.getStringExtra(Notices.EXTRA_ID)
    if (callId != null) CallCenter.answer(this, callId, intent.getBooleanExtra(EXTRA_AUDIO_ONLY, false))
    finish()
  }
}

@Suppress("DEPRECATION")
internal fun showOverLockScreen(activity: Activity, turnScreenOn: Boolean) {
  if (Build.VERSION.SDK_INT >= 27) {
    activity.setShowWhenLocked(true)
    if (turnScreenOn) activity.setTurnScreenOn(true)
  } else {
    activity.window.addFlags(
      WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        (if (turnScreenOn) WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON else 0),
    )
  }
}
