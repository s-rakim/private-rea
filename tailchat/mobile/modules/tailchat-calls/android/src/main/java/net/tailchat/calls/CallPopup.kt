package net.tailchat.calls

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.min

// The incoming call pop-up: a card at the top of the screen, over whatever
// app is open, with Decline and Answer. Tap it to open Tailchat; swipe it up
// to put the call away in the notification shade.
internal class CallPopup(private val context: Context) {
  private val windows = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
  private var root: FrameLayout? = null
  private var card: LinearLayout? = null
  private var avatar: ImageView? = null
  private var title: TextView? = null
  private var subtitle: TextView? = null
  private var kind: TextView? = null
  private var answerIcon: ImageView? = null
  private var answerButton: FrameLayout? = null
  private var pulse: ObjectAnimator? = null
  private var callId: String? = null

  val showing: Boolean get() = root != null

  fun show(ring: Ring) {
    if (root == null && !add()) return
    bind(ring)
  }

  fun hide() {
    val view = root ?: return
    root = null
    card = null
    pulse?.cancel()
    pulse = null
    callId = null
    try {
      windows.removeView(view)
    } catch (e: Exception) {
      Log.w(TAG, "couldn't remove the call pop-up", e)
    }
  }

  private fun bind(ring: Ring) {
    callId = ring.callId
    avatar?.setImageBitmap(ring.avatar(context, context.dp(52)))
    title?.text = ring.name
    subtitle?.text = ring.sub
    kind?.text = if (ring.ongoing) "Tailchat · call going on" else if (ring.video) "Tailchat · video call" else "Tailchat · voice call"
    answerIcon?.setImageResource(if (ring.video) R.drawable.tailchat_videocam else R.drawable.tailchat_call)
    answerButton?.contentDescription = if (ring.ongoing) "Join" else "Answer"
  }

  private fun add(): Boolean {
    val view = build()
    val metrics = context.resources.displayMetrics
    val width = min(metrics.widthPixels - context.dp(12), context.dp(560))
    @Suppress("DEPRECATION")
    val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
    val params = WindowManager.LayoutParams(
      width,
      WindowManager.LayoutParams.WRAP_CONTENT,
      type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
      PixelFormat.TRANSLUCENT,
    )
    params.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
    params.y = statusBarHeight() + context.dp(4)
    return try {
      windows.addView(view, params)
      root = view
      slideIn()
      true
    } catch (e: Exception) {
      // No permission to draw over other apps after all.
      Log.w(TAG, "couldn't show the call pop-up", e)
      false
    }
  }

  @SuppressLint("ClickableViewAccessibility")
  private fun build(): FrameLayout {
    val c = context
    val outer = FrameLayout(c)
    // Room for the card's shadow.
    outer.setPadding(c.dp(6), c.dp(4), c.dp(6), c.dp(14))
    outer.clipToPadding = false
    outer.clipChildren = false

    val cardView = LinearLayout(c)
    cardView.orientation = LinearLayout.HORIZONTAL
    cardView.gravity = Gravity.CENTER_VERTICAL
    cardView.setPadding(c.dp(14), c.dp(12), c.dp(12), c.dp(12))
    cardView.background = GradientDrawable(
      GradientDrawable.Orientation.TL_BR,
      intArrayOf(Color.parseColor("#F2262540"), Color.parseColor("#F2181722")),
    ).apply {
      cornerRadius = c.dp(28).toFloat()
      setStroke(c.dp(1), Color.parseColor("#33FFFFFF"))
    }
    cardView.elevation = c.dp(10).toFloat()
    cardView.isClickable = true

    val picture = ImageView(c)
    picture.scaleType = ImageView.ScaleType.CENTER_CROP
    cardView.addView(picture, LinearLayout.LayoutParams(c.dp(52), c.dp(52)))

    val texts = LinearLayout(c)
    texts.orientation = LinearLayout.VERTICAL
    texts.setPadding(c.dp(12), 0, c.dp(8), 0)
    val small = text(12f, "#B6B9D6")
    small.letterSpacing = 0.02f
    val name = text(17f, "#FFFFFF")
    name.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    val sub = text(14f, "#D3D5E4")
    texts.addView(small)
    texts.addView(name)
    texts.addView(sub)
    cardView.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

    val decline = roundButton(R.drawable.tailchat_call_end, "#E5484D", "Decline")
    decline.setOnClickListener { callId?.let { CallCenter.decline(it) } }
    cardView.addView(decline, LinearLayout.LayoutParams(c.dp(48), c.dp(48)))

    val answer = roundButton(R.drawable.tailchat_call, "#22B45E", "Answer")
    answer.setOnClickListener { callId?.let { CallCenter.answer(null, it, false) } }
    val answerParams = LinearLayout.LayoutParams(c.dp(48), c.dp(48))
    answerParams.marginStart = c.dp(10)
    cardView.addView(answer, answerParams)

    // Tap opens Tailchat; swipe up puts the call away.
    val slop = ViewConfiguration.get(c).scaledTouchSlop
    var downY = 0f
    var moved = false
    cardView.setOnTouchListener { v, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downY = e.rawY
          moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dy = e.rawY - downY
          if (abs(dy) > slop) moved = true
          if (dy < 0) {
            v.translationY = dy
            v.alpha = 1f + dy / (v.height.coerceAtLeast(1) * 1.5f)
          }
          true
        }
        MotionEvent.ACTION_UP -> {
          val dy = e.rawY - downY
          when {
            dy < -c.dp(36) -> slideOut { callId?.let { CallCenter.popupDismissed(it) } }
            !moved -> {
              v.animate().translationY(0f).alpha(1f).setDuration(120).start()
              callId?.let { CallCenter.openFromPopup(it) }
            }
            else -> v.animate().translationY(0f).alpha(1f).setDuration(160).start()
          }
          true
        }
        MotionEvent.ACTION_CANCEL -> {
          v.animate().translationY(0f).alpha(1f).setDuration(160).start()
          true
        }
        else -> false
      }
    }

    outer.addView(cardView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))

    card = cardView
    avatar = picture
    title = name
    subtitle = sub
    kind = small
    answerButton = answer
    answerIcon = answer.getChildAt(0) as? ImageView

    // A gentle beat on Answer while it rings.
    pulse = ObjectAnimator.ofPropertyValuesHolder(
      answer,
      PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.12f),
      PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.12f),
    ).apply {
      duration = 520
      repeatCount = ValueAnimator.INFINITE
      repeatMode = ValueAnimator.REVERSE
      start()
    }
    return outer
  }

  private fun text(size: Float, color: String): TextView {
    val t = TextView(context)
    t.textSize = size
    t.setTextColor(Color.parseColor(color))
    t.maxLines = 1
    t.ellipsize = TextUtils.TruncateAt.END
    t.includeFontPadding = false
    t.setPadding(0, context.dp(1), 0, context.dp(1))
    return t
  }

  private fun roundButton(icon: Int, color: String, label: String): FrameLayout {
    val b = FrameLayout(context)
    b.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor(color))
    }
    b.contentDescription = label
    b.isClickable = true
    b.isFocusable = true
    b.elevation = context.dp(2).toFloat()
    val image = ImageView(context)
    image.setImageResource(icon)
    image.setColorFilter(Color.WHITE)
    b.addView(image, FrameLayout.LayoutParams(context.dp(24), context.dp(24), Gravity.CENTER))
    return b
  }

  private fun slideIn() {
    val v = card ?: return
    v.translationY = -context.dp(120).toFloat()
    v.alpha = 0f
    v.animate().translationY(0f).alpha(1f).setDuration(260).setInterpolator(DecelerateInterpolator()).start()
  }

  private fun slideOut(done: () -> Unit) {
    val v = card
    if (v == null) {
      done()
      return
    }
    v.animate().translationY(-v.height.toFloat() - context.dp(40)).alpha(0f).setDuration(180).withEndAction { done() }.start()
  }

  private fun statusBarHeight(): Int {
    val id = context.resources.getIdentifier("status_bar_height", "dimen", "android")
    return if (id > 0) context.resources.getDimensionPixelSize(id) else context.dp(24)
  }
}
