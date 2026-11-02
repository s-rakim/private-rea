package net.tailchat.calls

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The bridge between the app's JavaScript and the Android side (CallCenter).
// The app passes Tailchat's page messages in with post(json) and hands the
// page whatever comes back as "message" events.
class TailchatCallsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TailchatCalls")

    Events("message")

    OnCreate {
      val context = appContext.reactContext ?: return@OnCreate
      CallCenter.onMain {
        CallCenter.attach(context, appContext.currentActivity) { json ->
          this@TailchatCallsModule.sendEvent("message", mapOf("json" to json))
        }
      }
    }

    OnDestroy {
      CallCenter.onMain { CallCenter.detach() }
    }

    Function("post") { json: String ->
      CallCenter.fromPage(json)
    }

    OnActivityEntersForeground {
      val activity = appContext.currentActivity
      CallCenter.onMain { CallCenter.hostResumed(activity) }
    }

    OnUserLeavesActivity {
      CallCenter.onMain { CallCenter.userLeaving() }
    }

    OnNewIntent { intent ->
      CallCenter.onMain { CallCenter.intent(intent) }
    }
  }
}
