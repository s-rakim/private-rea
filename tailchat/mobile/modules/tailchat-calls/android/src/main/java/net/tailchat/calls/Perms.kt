package net.tailchat.calls

import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

// What Android currently lets the app do. The page shows these in its call
// settings, each with a button to the right page of the phone's settings.
internal object Perms {
  fun granted(context: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  // "Display over other apps", for the incoming call pop-up.
  fun overlay(context: Context): Boolean = Settings.canDrawOverlays(context)

  // Android 14 asks before an app may fill the lock screen with a call.
  fun fullScreen(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 34) return true
    val manager = context.getSystemService(NotificationManager::class.java) ?: return false
    return manager.canUseFullScreenIntent()
  }

  fun notifications(context: Context): Boolean = NotificationManagerCompat.from(context).areNotificationsEnabled()

  // Messages drop down from the top only while their channel is "pop on
  // screen" (high importance); a person can turn that down in the settings.
  fun messagePopups(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 26) return true
    val manager = context.getSystemService(NotificationManager::class.java) ?: return true
    val channel = manager.getNotificationChannel(Notices.CH_MESSAGES) ?: return true
    return channel.importance >= NotificationManager.IMPORTANCE_HIGH
  }

  fun battery(context: Context): Boolean {
    val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
    return power.isIgnoringBatteryOptimizations(context.packageName)
  }

  @Suppress("DEPRECATION")
  fun pip(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < 26) return false
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
    val ops = context.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return true
    val mode = try {
      if (Build.VERSION.SDK_INT >= 29) {
        ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), context.packageName)
      } else {
        ops.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE, Process.myUid(), context.packageName)
      }
    } catch (e: Exception) {
      AppOpsManager.MODE_ALLOWED
    }
    return mode == AppOpsManager.MODE_ALLOWED
  }
}

// Settings the app keeps for itself, so they hold while Tailchat's page
// isn't loaded.
internal object Prefs {
  private const val FILE = "tailchat-calls"

  private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  // Stay connected in the background so calls ring and messages show.
  fun keepAlive(context: Context): Boolean = prefs(context).getBoolean("keepAlive", true)

  fun setKeepAlive(context: Context, on: Boolean) {
    prefs(context).edit().putBoolean("keepAlive", on).apply()
  }

  // Android 13 and later ask once for notifications; after that the page's
  // settings open the phone's notification settings instead.
  fun askedNotifications(context: Context): Boolean = prefs(context).getBoolean("askedNotifications", false)

  fun setAskedNotifications(context: Context) {
    prefs(context).edit().putBoolean("askedNotifications", true).apply()
  }

  // The last call pop-up was hidden by the phone.
  fun popupBlocked(context: Context): Boolean = prefs(context).getBoolean("popupBlocked", false)

  fun setPopupBlocked(context: Context, on: Boolean) {
    prefs(context).edit().putBoolean("popupBlocked", on).apply()
  }
}
