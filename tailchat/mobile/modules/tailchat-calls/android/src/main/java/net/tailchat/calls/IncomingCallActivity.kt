package net.tailchat.calls

import android.animation.Animator
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

// The incoming call on the lock screen: the caller's picture rippling over
// a glow in their colour, the same as Tailchat's own ring screen, with
// Decline, Voice only (for a video call) and Answer. Android opens it when
// a call comes in while the phone is locked or its screen is off; while you
// use the phone the call pops up as a card instead.
class IncomingCallActivity : Activity() {
  companion object {
    private var current: WeakReference<IncomingCallActivity>? = null

    // Open, and not on its way out.
    val showing: Boolean get() = current?.get()?.let { !it.isFinishing } == true

    fun intent(context: Context, callId: String): Intent =
      Intent(context, IncomingCallActivity::class.java)
        .putExtra(Notices.EXTRA_ID, callId)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)

    fun start(context: Context, callId: String) {
      try {
        context.startActivity(intent(context, callId))
      } catch (e: Exception) {
        android.util.Log.w(TAG, "couldn't open the incoming call screen", e)
      }
    }

    // The call stopped ringing (or any call, with null).
    fun close(callId: String?) {
      val screen = current?.get() ?: return
      if (callId == null || screen.callId == callId) screen.finish()
    }

    // The page sent more about the call, such as the caller's picture.
    fun refresh() {
      current?.get()?.let { it.bind(it.intent) }
    }
  }

  private var callId: String? = null
  private lateinit var glow: View
  private lateinit var avatar: ImageView
  private lateinit var name: TextView
  private lateinit var sub: TextView
  private lateinit var label: TextView
  private lateinit var answerIcon: ImageView
  private lateinit var answerLabel: TextView
  private lateinit var voiceOnly: View
  private val rings = ArrayList<View>()
  private val animations = ArrayList<Animator>()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    current = WeakReference(this)
    showOverLockScreen(this, turnScreenOn = true)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    setContentView(build())
    bind(intent)
    animate()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    bind(intent)
  }

  override fun onStart() {
    super.onStart()
    CallCenter.fullScreenShown(true)
  }

  override fun onStop() {
    CallCenter.fullScreenShown(false)
    super.onStop()
  }

  override fun onDestroy() {
    for (a in animations) a.cancel()
    animations.clear()
    if (current?.get() === this) current = null
    super.onDestroy()
  }

  private fun bind(intent: Intent?) {
    val id = intent?.getStringExtra(Notices.EXTRA_ID)
    val ring = id?.let { CallCenter.ring(it) }
    if (ring == null) {
      finish()
      return
    }
    callId = id
    val tint = Avatars.parseColor(ring.color)
    avatar.setImageBitmap(ring.avatar(this, dp(148)))
    name.text = ring.name
    sub.text = ring.sub
    label.text = if (ring.ongoing) "TAILCHAT · CALL GOING ON" else if (ring.video) "TAILCHAT · VIDEO CALL" else "TAILCHAT · VOICE CALL"
    answerIcon.setImageResource(if (ring.video) R.drawable.tailchat_videocam else R.drawable.tailchat_call)
    answerLabel.text = if (ring.ongoing) "Join" else "Answer"
    voiceOnly.visibility = if (ring.video) View.VISIBLE else View.GONE
    glow.background = GradientDrawable().apply {
      gradientType = GradientDrawable.RADIAL_GRADIENT
      gradientRadius = dp(260).toFloat()
      colors = intArrayOf(withAlpha(tint, 0x88), withAlpha(ACCENT, 0x30), Color.TRANSPARENT)
    }
    val ringColor = blend(tint, Color.WHITE, 0.3f)
    for (r in rings) {
      (r.background as? GradientDrawable)?.setStroke(dp(2), ringColor)
    }
  }

  private fun build(): View {
    val root = FrameLayout(this)
    root.setBackgroundColor(Color.parseColor("#0C0B0C"))

    // The light behind the caller.
    glow = View(this)
    val glowSize = dp(560)
    val glowParams = FrameLayout.LayoutParams(glowSize, glowSize, Gravity.CENTER_HORIZONTAL or Gravity.TOP)
    glowParams.topMargin = dp(0)
    root.addView(glow, glowParams)

    val shade = View(this)
    shade.background = GradientDrawable(
      GradientDrawable.Orientation.TOP_BOTTOM,
      intArrayOf(Color.parseColor("#66000000"), Color.TRANSPARENT, Color.parseColor("#99000000")),
    )
    root.addView(shade, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

    val column = LinearLayout(this)
    column.orientation = LinearLayout.VERTICAL
    column.gravity = Gravity.CENTER_HORIZONTAL
    root.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    ViewCompat.setOnApplyWindowInsetsListener(column) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      v.setPadding(dp(24) + bars.left, bars.top + dp(36), dp(24) + bars.right, bars.bottom + dp(44))
      WindowInsetsCompat.CONSUMED
    }

    label = TextView(this).apply {
      textSize = 12f
      letterSpacing = 0.14f
      setTextColor(Color.parseColor("#B9BCD9"))
      gravity = Gravity.CENTER
    }
    column.addView(label, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    column.addView(View(this), LinearLayout.LayoutParams(1, 0, 0.6f))

    // The picture with its ripples.
    val pulse = FrameLayout(this)
    pulse.clipChildren = false
    val pictureSize = dp(148)
    for (i in 0 until 3) {
      val r = View(this)
      r.background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.TRANSPARENT)
        setStroke(dp(2), Color.WHITE)
      }
      r.alpha = 0f
      pulse.addView(r, FrameLayout.LayoutParams(pictureSize, pictureSize, Gravity.CENTER))
      rings.add(r)
    }
    avatar = ImageView(this)
    avatar.scaleType = ImageView.ScaleType.CENTER_CROP
    avatar.elevation = dp(12).toFloat()
    pulse.addView(avatar, FrameLayout.LayoutParams(pictureSize, pictureSize, Gravity.CENTER))
    val pulseParams = LinearLayout.LayoutParams(dp(300), dp(300))
    column.addView(pulse, pulseParams)

    name = TextView(this).apply {
      textSize = 32f
      setTextColor(Color.WHITE)
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      gravity = Gravity.CENTER
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      setShadowLayer(dp(9).toFloat(), 0f, dp(1).toFloat(), Color.parseColor("#66000000"))
    }
    column.addView(name, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    sub = TextView(this).apply {
      textSize = 16f
      setTextColor(Color.parseColor("#D3D5E4"))
      gravity = Gravity.CENTER
      maxLines = 2
      ellipsize = TextUtils.TruncateAt.END
      setPadding(0, dp(8), 0, 0)
    }
    column.addView(sub, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    column.addView(View(this), LinearLayout.LayoutParams(1, 0, 1f))

    // Decline, Voice only, Answer.
    val buttons = LinearLayout(this)
    buttons.orientation = LinearLayout.HORIZONTAL
    buttons.gravity = Gravity.CENTER
    buttons.weightSum = 3f
    val decline = actionColumn("Decline", R.drawable.tailchat_call_end, "#E5484D", dp(74)) {
      callId?.let { CallCenter.decline(it) }
      finish()
    }
    voiceOnly = actionColumn("Voice only", R.drawable.tailchat_mic, "#33343F", dp(60)) {
      callId?.let { CallCenter.answer(this, it, true) }
      finish()
    }
    val answer = actionColumn("Answer", R.drawable.tailchat_call, "#22B45E", dp(74)) {
      callId?.let { CallCenter.answer(this, it, false) }
      finish()
    }
    answerIcon = (answer.getChildAt(0) as FrameLayout).getChildAt(0) as ImageView
    answerLabel = answer.getChildAt(1) as TextView
    buttons.addView(decline, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    buttons.addView(voiceOnly, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    buttons.addView(answer, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    column.addView(buttons, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

    // Answer bobs a little, the way a phone's does.
    val bob = ObjectAnimator.ofFloat(answer.getChildAt(0), View.TRANSLATION_Y, 0f, -dp(10).toFloat(), 0f)
    bob.duration = 1300
    bob.repeatCount = ValueAnimator.INFINITE
    bob.interpolator = AccelerateDecelerateInterpolator()
    animations.add(bob)
    return root
  }

  private fun actionColumn(text: String, icon: Int, color: String, size: Int, onClick: () -> Unit): LinearLayout {
    val col = LinearLayout(this)
    col.orientation = LinearLayout.VERTICAL
    col.gravity = Gravity.CENTER_HORIZONTAL
    val button = FrameLayout(this)
    button.background = GradientDrawable().apply {
      shape = GradientDrawable.OVAL
      setColor(Color.parseColor(color))
    }
    button.elevation = dp(6).toFloat()
    button.isClickable = true
    button.isFocusable = true
    button.contentDescription = text
    button.setOnClickListener { onClick() }
    val image = ImageView(this)
    image.setImageResource(icon)
    image.setColorFilter(Color.WHITE)
    button.addView(image, FrameLayout.LayoutParams(size * 4 / 9, size * 4 / 9, Gravity.CENTER))
    col.addView(button, LinearLayout.LayoutParams(size, size))
    val caption = TextView(this)
    caption.text = text
    caption.textSize = 14f
    caption.setTextColor(Color.parseColor("#E4E5EE"))
    caption.gravity = Gravity.CENTER
    caption.setPadding(0, dp(10), 0, 0)
    col.addView(caption, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    return col
  }

  // Ripples out from the picture, three at a time, like Tailchat's ring screen.
  private fun animate() {
    rings.forEachIndexed { i, r ->
      val ripple = ObjectAnimator.ofPropertyValuesHolder(
        r,
        PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.95f),
        PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.95f),
        PropertyValuesHolder.ofFloat(View.ALPHA, 0.75f, 0f),
      )
      ripple.duration = 2400
      ripple.startDelay = i * 800L
      ripple.repeatCount = ValueAnimator.INFINITE
      ripple.interpolator = DecelerateInterpolator(1.6f)
      animations.add(ripple)
    }
    for (a in animations) a.start()
  }

  private fun withAlpha(color: Int, alpha: Int): Int = (color and 0x00FFFFFF) or (alpha shl 24)

  private fun blend(a: Int, b: Int, amount: Float): Int {
    val inv = 1f - amount
    return Color.rgb(
      (Color.red(a) * inv + Color.red(b) * amount).toInt(),
      (Color.green(a) * inv + Color.green(b) * amount).toInt(),
      (Color.blue(a) * inv + Color.blue(b) * amount).toInt(),
    )
  }
}
