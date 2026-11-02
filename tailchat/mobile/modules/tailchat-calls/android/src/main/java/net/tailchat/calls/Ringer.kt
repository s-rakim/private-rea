package net.tailchat.calls

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

// The phone's own ringtone and vibration for an incoming call. It follows
// the ring volume, silent and vibrate mode, and Do Not Disturb.
internal class Ringer(private val context: Context) {
  private val handler = Handler(Looper.getMainLooper())
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var ringtone: Ringtone? = null
  private var vibrator: Vibrator? = null
  private var focus: AudioFocusRequest? = null
  private var replay: Runnable? = null

  val ringing: Boolean get() = ringtone != null || vibrator != null

  private val attributes: AudioAttributes = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()

  fun start(sound: Boolean, vibrate: Boolean) {
    if (ringing) return
    if (quiet()) return
    val mode = audio.ringerMode
    if (sound && mode == AudioManager.RINGER_MODE_NORMAL) play()
    if (vibrate && mode != AudioManager.RINGER_MODE_SILENT) buzz()
  }

  fun stop() {
    replay?.let { handler.removeCallbacks(it) }
    replay = null
    try {
      ringtone?.stop()
    } catch (e: Exception) {
      Log.w(TAG, "couldn't stop the ringtone", e)
    }
    ringtone = null
    try {
      vibrator?.cancel()
    } catch (e: Exception) {
      Log.w(TAG, "couldn't stop vibrating", e)
    }
    vibrator = null
    if (Build.VERSION.SDK_INT >= 26) focus?.let { audio.abandonAudioFocusRequest(it) }
    focus = null
  }

  // Do Not Disturb: only ring when calls from this app may come through.
  private fun quiet(): Boolean {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return false
    return when (manager.currentInterruptionFilter) {
      NotificationManager.INTERRUPTION_FILTER_NONE, NotificationManager.INTERRUPTION_FILTER_ALARMS -> true
      NotificationManager.INTERRUPTION_FILTER_PRIORITY -> {
        val channel = if (Build.VERSION.SDK_INT >= 26) manager.getNotificationChannel(Notices.CH_CALLS) else null
        channel?.canBypassDnd() != true
      }
      else -> false
    }
  }

  private fun play() {
    try {
      // None: the ringtone chosen in the phone's settings is silence.
      val uri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_RINGTONE) ?: return
      val tone = RingtoneManager.getRingtone(context, uri) ?: return
      tone.audioAttributes = attributes
      if (Build.VERSION.SDK_INT >= 28) tone.isLooping = true
      if (Build.VERSION.SDK_INT >= 26) {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(attributes)
          .build()
        audio.requestAudioFocus(request)
        focus = request
      }
      tone.play()
      ringtone = tone
      if (Build.VERSION.SDK_INT < 28) {
        // No looping before Android 9: start it again when it ends.
        val again = object : Runnable {
          override fun run() {
            val current = ringtone ?: return
            if (!current.isPlaying) current.play()
            handler.postDelayed(this, 1000)
          }
        }
        replay = again
        handler.postDelayed(again, 1000)
      }
    } catch (e: Exception) {
      Log.w(TAG, "couldn't play the ringtone", e)
      ringtone = null
    }
  }

  @Suppress("DEPRECATION")
  private fun buzz() {
    try {
      val found = if (Build.VERSION.SDK_INT >= 31) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
      } else {
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
      }
      val v = found ?: return
      if (!v.hasVibrator()) return
      val pattern = longArrayOf(0, 900, 700)
      if (Build.VERSION.SDK_INT >= 26) {
        v.vibrate(VibrationEffect.createWaveform(pattern, 1), attributes)
      } else {
        v.vibrate(pattern, 1, attributes)
      }
      vibrator = v
    } catch (e: Exception) {
      Log.w(TAG, "couldn't vibrate", e)
      vibrator = null
    }
  }
}
