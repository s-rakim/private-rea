package net.tailchat.calls

import android.content.Context
import android.graphics.Bitmap
import org.json.JSONObject

// A string field, or null when it's missing or JSON null.
internal fun JSONObject.str(key: String): String? =
  if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null

// A call ringing on this device, as the page described it.
internal class Ring(val callId: String) {
  var chatId = ""
  var name = "Tailchat"
  var sub = "Incoming call"
  var video = false
  var ongoing = false
  var waiting = false
  var color: String? = null
  var initials = "?"
  var photo: String? = null
  var ringtone = true
  var vibrate = true

  // The power button silences it, as it does a phone call.
  var silenced = false

  // Swiped the pop-up away: the call stays in the notification shade.
  var popupDismissed = false

  // The phone didn't let the pop-up show: ring with the call notification.
  var popupBlocked = false

  private var picture: Bitmap? = null
  private var pictureKey = ""

  fun update(m: JSONObject) {
    m.str("chatId")?.let { chatId = it }
    m.str("name")?.let { name = it.take(80) }
    m.str("sub")?.let { sub = it.take(120) }
    video = m.optBoolean("video", video)
    ongoing = m.optBoolean("ongoing", ongoing)
    waiting = m.optBoolean("waiting", waiting)
    m.str("color")?.let { color = it }
    m.str("initials")?.let { initials = it }
    m.str("photo")?.let { photo = it }
    ringtone = m.optBoolean("ringtone", ringtone)
    vibrate = m.optBoolean("vibrate", vibrate)
  }

  fun avatar(context: Context, size: Int = context.dp(96)): Bitmap {
    val key = "$size|$initials|$color|${photo?.length ?: 0}"
    val cached = picture
    if (cached != null && key == pictureKey) return cached
    val made = Avatars.round(photo, initials, color, size)
    picture = made
    pictureKey = key
    return made
  }
}

// The call this device is on, as the page last described it.
internal class CallInfo(m: JSONObject) {
  val callId: String = m.str("callId") ?: ""
  val chatId: String = m.str("chatId") ?: ""
  val title: String = (m.str("title") ?: "Tailchat call").take(80)
  val status: String = m.str("status") ?: "connecting"
  val startedAt: Long = m.optLong("startedAt", 0L)
  val video: Boolean = m.optBoolean("video", false)
  val muted: Boolean = m.optBoolean("muted", false)
  val cameraOff: Boolean = m.optBoolean("cameraOff", true)

  // Width over height of the main video, for picture in picture.
  val aspect: Double = m.optDouble("aspect", 0.0).let { if (it.isNaN() || it <= 0.0) 0.0 else it }
}

// One message in a chat's notification.
internal class Line(
  val sender: String,
  val senderKey: String?,
  val text: String,
  val at: Long,
  private val color: String?,
  private val initials: String,
  private val photo: String?,
) {
  private var picture: Bitmap? = null

  fun avatar(context: Context): Bitmap =
    picture ?: Avatars.round(photo, initials, color, context.dp(64)).also { picture = it }
}

// The new messages of one chat, shown together in its notification.
internal class ChatNote(val chatId: String) {
  var title = "Tailchat"
  var group = false
  var count = 0
  val lines = ArrayList<Line>()
}
