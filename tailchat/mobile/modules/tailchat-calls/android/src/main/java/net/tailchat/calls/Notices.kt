package net.tailchat.calls

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat

// The app's notifications: incoming, ongoing and missed calls, new
// messages, and the small one while Tailchat stays connected.
internal object Notices {
  const val CH_CALLS = "tailchat_calls"
  const val CH_CALLS_QUIET = "tailchat_calls_quiet"
  const val CH_ONGOING = "tailchat_ongoing"
  const val CH_MISSED = "tailchat_missed"
  const val CH_MESSAGES = "tailchat_messages"
  const val CH_CONNECTION = "tailchat_connection"

  const val ID_INCOMING = 7301
  const val ID_SERVICE = 7302
  const val ID_MISSED = 7303
  const val ID_MESSAGE = 7304

  // Extras on the intents that open the app.
  const val ACTION_OPEN = "net.tailchat.calls.OPEN"
  const val EXTRA_ACTION = "net.tailchat.calls.action"
  const val EXTRA_ID = "net.tailchat.calls.id"
  const val EXTRA_VIDEO = "net.tailchat.calls.video"
  const val EXTRA_NOTE = "net.tailchat.calls.note"
  const val KEY_REPLY = "net.tailchat.calls.reply"

  // The server stops ringing after 45 seconds; a notification left behind
  // by an app that went away clears itself a little later.
  private const val RING_LIMIT_MS = 70_000L

  private const val IMMUTABLE = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  fun createChannels(context: Context) {
    val channels = listOf(
      // Tailchat plays the ringtone itself, so the channel has no sound.
      NotificationChannelCompat.Builder(CH_CALLS, NotificationManagerCompat.IMPORTANCE_HIGH)
        .setName("Incoming calls")
        .setDescription("Pops up when someone calls you, and fills the lock screen")
        .setSound(null, null)
        .setVibrationEnabled(false)
        .setShowBadge(false)
        .build(),
      NotificationChannelCompat.Builder(CH_CALLS_QUIET, NotificationManagerCompat.IMPORTANCE_LOW)
        .setName("Incoming calls behind the pop-up")
        .setDescription("The call in the notification shade while its pop-up shows over other apps")
        .setShowBadge(false)
        .build(),
      NotificationChannelCompat.Builder(CH_ONGOING, NotificationManagerCompat.IMPORTANCE_LOW)
        .setName("Calls in progress")
        .setDescription("The call you're on, with Mute and Hang up")
        .setShowBadge(false)
        .build(),
      NotificationChannelCompat.Builder(CH_MISSED, NotificationManagerCompat.IMPORTANCE_DEFAULT)
        .setName("Missed calls")
        .build(),
      NotificationChannelCompat.Builder(CH_MESSAGES, NotificationManagerCompat.IMPORTANCE_HIGH)
        .setName("Messages")
        .setDescription("New messages pop up with the sender and a preview")
        .build(),
      NotificationChannelCompat.Builder(CH_CONNECTION, NotificationManagerCompat.IMPORTANCE_MIN)
        .setName("Staying connected")
        .setDescription("Shown while Tailchat stays connected in the background")
        .setShowBadge(false)
        .build(),
    )
    NotificationManagerCompat.from(context).createNotificationChannelsCompat(channels)
  }

  fun post(context: Context, tag: String?, id: Int, notification: Notification) {
    try {
      NotificationManagerCompat.from(context).notify(tag, id, notification)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't show a notification", e)
    }
  }

  fun cancel(context: Context, tag: String?, id: Int) {
    try {
      NotificationManagerCompat.from(context).cancel(tag, id)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't clear a notification", e)
    }
  }

  // ---------- intents ----------

  // Brings Tailchat to the front. With an action, the page acts on it: open a
  // chat, or call back. Its own action keeps Android from treating it as a
  // tap on the app's icon, which would drop the extras.
  fun openIntent(context: Context, action: String? = null, id: String? = null, video: Boolean = false, note: String? = null): Intent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    val intent = Intent(ACTION_OPEN)
      .setComponent(launch.component)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (action != null) intent.putExtra(EXTRA_ACTION, action)
    if (id != null) intent.putExtra(EXTRA_ID, id)
    if (video) intent.putExtra(EXTRA_VIDEO, true)
    if (note != null) intent.putExtra(EXTRA_NOTE, note)
    return intent
  }

  private fun openPending(context: Context, action: String? = null, id: String? = null, video: Boolean = false, note: String? = null): PendingIntent? {
    val intent = openIntent(context, action, id, video, note) ?: return null
    return PendingIntent.getActivity(context, code("open", action, id, video), intent, IMMUTABLE)
  }

  fun actionPending(context: Context, action: String, id: String, mutable: Boolean = false): PendingIntent {
    val intent = Intent(context, ActionReceiver::class.java)
      .setAction(action)
      .putExtra(EXTRA_ID, id)
    val flags = if (mutable) {
      PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    } else {
      IMMUTABLE
    }
    return PendingIntent.getBroadcast(context, code(action, id), intent, flags)
  }

  // Answer goes through a see-through activity that may show over the lock
  // screen, so a locked phone can answer straight away.
  private fun answerPending(context: Context, callId: String, audioOnly: Boolean): PendingIntent {
    val intent = Intent(context, AnswerActivity::class.java)
      .putExtra(EXTRA_ID, callId)
      .putExtra(AnswerActivity.EXTRA_AUDIO_ONLY, audioOnly)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
    return PendingIntent.getActivity(context, code("answer", callId, audioOnly), intent, IMMUTABLE)
  }

  private fun fullScreenPending(context: Context, callId: String): PendingIntent =
    PendingIntent.getActivity(context, code("full", callId), IncomingCallActivity.intent(context, callId), IMMUTABLE)

  private fun code(vararg parts: Any?): Int = parts.joinToString("|").hashCode()

  // ---------- calls ----------

  enum class RingStyle {
    // Heads-up with Answer and Decline, full screen on the lock screen.
    LOUD,

    // Silenced with the power button: still on the lock screen, no sound.
    SILENCED,

    // Behind the pop-up, in the notification shade only.
    QUIET,
  }

  fun incoming(context: Context, ring: Ring, style: RingStyle): Notification {
    val picture = ring.avatar(context)
    val caller = Person.Builder()
      .setName(ring.name)
      .setIcon(IconCompat.createWithBitmap(picture))
      .setImportant(true)
      .build()
    val decline = actionPending(context, ActionReceiver.DECLINE, ring.callId)
    val answer = answerPending(context, ring.callId, false)
    val builder = NotificationCompat.Builder(context, if (style == RingStyle.QUIET) CH_CALLS_QUIET else CH_CALLS)
      .setSmallIcon(if (ring.video) R.drawable.tailchat_videocam else R.drawable.tailchat_call)
      .setContentTitle(ring.name)
      .setContentText(ring.sub)
      .setLargeIcon(picture)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setPriority(if (style == RingStyle.QUIET) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setTimeoutAfter(RING_LIMIT_MS)
      .setColor(ACCENT)
      .addPerson(caller)
    openPending(context)?.let { builder.setContentIntent(it) }
    if (style == RingStyle.LOUD) {
      builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(ring.video))
      builder.setFullScreenIntent(fullScreenPending(context, ring.callId), true)
    } else {
      builder.addAction(R.drawable.tailchat_call_end, "Decline", decline)
      builder.addAction(if (ring.video) R.drawable.tailchat_videocam else R.drawable.tailchat_call, if (ring.ongoing) "Join" else "Answer", answer)
    }
    return builder.build()
  }

  fun ongoing(context: Context, call: CallInfo): Notification {
    val person = Person.Builder().setName(call.title).setImportant(true).build()
    val hangup = actionPending(context, ActionReceiver.HANGUP, call.callId)
    val mute = actionPending(context, if (call.muted) ActionReceiver.UNMUTE else ActionReceiver.MUTE, call.callId)
    val builder = NotificationCompat.Builder(context, CH_ONGOING)
      .setSmallIcon(if (call.video) R.drawable.tailchat_videocam else R.drawable.tailchat_call)
      .setContentTitle(call.title)
      .setContentText(statusText(call))
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setColor(ACCENT)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangup).setIsVideo(call.video))
      .addPerson(person)
      .addAction(if (call.muted) R.drawable.tailchat_mic_off else R.drawable.tailchat_mic, if (call.muted) "Unmute" else "Mute", mute)
    openPending(context)?.let { builder.setContentIntent(it) }
    if (call.status == "active" && call.startedAt > 0) {
      builder.setWhen(call.startedAt).setShowWhen(true).setUsesChronometer(true)
    } else {
      builder.setShowWhen(false)
    }
    return builder.build()
  }

  private fun statusText(call: CallInfo): String = when (call.status) {
    "calling" -> "Calling…"
    "ringing" -> "Ringing…"
    "reconnecting" -> "Reconnecting…"
    "active" -> if (call.video) "Video call" else "Voice call"
    else -> "Connecting…"
  }

  fun standby(context: Context): Notification {
    val builder = NotificationCompat.Builder(context, CH_CONNECTION)
      .setSmallIcon(R.drawable.tailchat_notification)
      .setContentTitle("Ready for calls")
      .setContentText("Tailchat stays connected so calls ring and messages show")
      .setOngoing(true)
      .setSilent(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setColor(ACCENT)
      .addAction(0, "Turn off", actionPending(context, ActionReceiver.STANDBY_OFF, ""))
    openPending(context)?.let { builder.setContentIntent(it) }
    return builder.build()
  }

  fun missed(context: Context, tag: String, chatId: String, name: String, text: String, video: Boolean): Notification {
    val builder = NotificationCompat.Builder(context, CH_MISSED)
      .setSmallIcon(R.drawable.tailchat_call_missed)
      .setContentTitle(name)
      .setContentText(text)
      .setCategory("missed_call")
      .setAutoCancel(true)
      .setColor(ACCENT)
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
    if (chatId.isNotEmpty()) {
      openPending(context, "open-chat", chatId)?.let { builder.setContentIntent(it) }
      openPending(context, "call-back", chatId, video, tag)?.let { builder.addAction(R.drawable.tailchat_call, "Call back", it) }
    } else {
      openPending(context)?.let { builder.setContentIntent(it) }
    }
    return builder.build()
  }

  // ---------- messages ----------

  fun message(context: Context, chat: ChatNote): Notification {
    val me = Person.Builder().setName("You").build()
    val style = NotificationCompat.MessagingStyle(me)
    if (chat.group) {
      style.setConversationTitle(chat.title)
      style.setGroupConversation(true)
    }
    for (line in chat.lines) {
      val sender = Person.Builder()
        .setName(line.sender)
        .setKey(line.senderKey)
        .setIcon(IconCompat.createWithBitmap(line.avatar(context)))
        .build()
      style.addMessage(NotificationCompat.MessagingStyle.Message(line.text, line.at, sender))
    }
    val reply = NotificationCompat.Action.Builder(R.drawable.tailchat_reply, "Reply", actionPending(context, ActionReceiver.REPLY, chat.chatId, mutable = true))
      .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Message").build())
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
      .setShowsUserInterface(false)
      .build()
    val read = NotificationCompat.Action.Builder(R.drawable.tailchat_done, "Mark as read", actionPending(context, ActionReceiver.READ, chat.chatId))
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
      .setShowsUserInterface(false)
      .build()
    val last = chat.lines.lastOrNull()
    val builder = NotificationCompat.Builder(context, CH_MESSAGES)
      .setSmallIcon(R.drawable.tailchat_notification)
      .setStyle(style)
      .setContentTitle(chat.title)
      .setContentText(last?.text ?: "New message")
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setColor(ACCENT)
      .setNumber(chat.count)
      .setWhen(last?.at ?: System.currentTimeMillis())
      .setShowWhen(true)
      .setDeleteIntent(actionPending(context, ActionReceiver.DISMISSED, chat.chatId))
      .addAction(reply)
      .addAction(read)
    openPending(context, "open-chat", chat.chatId)?.let { builder.setContentIntent(it) }
    return builder.build()
  }
}
