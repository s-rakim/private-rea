package net.tailchat.calls

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.util.Base64
import kotlin.math.min

internal const val ACCENT = 0xFF3F5DB3.toInt()

internal fun Context.dp(value: Float): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

internal fun Context.dp(value: Int): Int = dp(value.toFloat())

// Round pictures for the call pop-up, the lock screen and notifications:
// the profile photo the page sent, or initials on the person's colour, the
// same as the avatars in the app.
internal object Avatars {
  fun round(photo: String?, initials: String, color: String?, size: Int): Bitmap {
    val decoded = decode(photo)
    return if (decoded != null) crop(decoded, size) else initials(initials, color, size)
  }

  // Only a small JPEG or PNG made by the page (a data: URL) is accepted.
  fun decode(photo: String?): Bitmap? {
    if (photo.isNullOrEmpty() || photo.length > 2_000_000) return null
    if (!photo.startsWith("data:image/jpeg;base64,") && !photo.startsWith("data:image/png;base64,")) return null
    return try {
      val bytes = Base64.decode(photo.substring(photo.indexOf(',') + 1), Base64.DEFAULT)
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    } catch (e: Exception) {
      null
    }
  }

  fun parseColor(color: String?, fallback: Int = ACCENT): Int {
    if (color == null || !Regex("^#[0-9a-fA-F]{6}$").matches(color)) return fallback
    return try {
      Color.parseColor(color)
    } catch (e: IllegalArgumentException) {
      fallback
    }
  }

  private fun crop(src: Bitmap, size: Int): Bitmap {
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val scale = size / min(src.width, src.height).toFloat()
    val matrix = Matrix()
    matrix.setScale(scale, scale)
    matrix.postTranslate((size - src.width * scale) / 2f, (size - src.height * scale) / 2f)
    val shader = BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    shader.setLocalMatrix(matrix)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    paint.shader = shader
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    return out
  }

  private fun initials(text: String, color: String?, size: Int): Bitmap {
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val background = Paint(Paint.ANTI_ALIAS_FLAG)
    background.color = parseColor(color)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, background)
    val letters = text.trim().take(2).ifEmpty { "?" }
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.color = Color.WHITE
    paint.textSize = size * if (letters.length > 1) 0.38f else 0.44f
    paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    paint.textAlign = Paint.Align.CENTER
    val y = size / 2f - (paint.descent() + paint.ascent()) / 2f
    canvas.drawText(letters, size / 2f, y, paint)
    return out
  }
}
