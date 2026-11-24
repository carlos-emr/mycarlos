import PushCore
import SwiftRs
import Tauri
import UIKit
import UserNotifications
import WebKit

/// iPhone push registration (the push design, piece 2). Nothing here is shown to JavaScript: the
/// app's own Rust code calls `requestToken` and `permission`. UNVERIFIED until macOS CI builds it.
class PushPlugin: Plugin, UNUserNotificationCenterDelegate {
  private let hook = RegistrationHook()
  /// The asks that wait for Apple's answer. Only touched on the main queue.
  private var waiting: [Invoke] = []
  /// How long to wait for Apple before giving up.
  private static let patience: TimeInterval = 30

  /// A development build gets sandbox tokens; TestFlight and App Store builds get production ones.
  private static var environment: String {
    #if DEBUG
      return "sandbox"
    #else
      return "production"
    #endif
  }

  override func load(webview: WKWebView) {
    UNUserNotificationCenter.current().delegate = self
    DispatchQueue.main.async {
      guard let delegate = UIApplication.shared.delegate else { return }
      self.hook.install(on: type(of: delegate)) { [weak self] result in
        DispatchQueue.main.async { self?.finish(result) }
      }
    }
  }

  /// Asks for permission to show notices (the system's own question, shown once) and then for the
  /// device token. Called only after the patient has turned the setting on.
  @objc public func requestToken(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, _ in
      DispatchQueue.main.async {
        guard granted else {
          invoke.reject("push_permission_refused")
          return
        }
        self.waiting.append(invoke)
        UIApplication.shared.registerForRemoteNotifications()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.patience) {
          self.finish(.failure("push_token_timeout"))
        }
      }
    }
  }

  /// The permission as it is now, without asking.
  @objc public func permission(_ invoke: Invoke) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let status: String
      switch settings.authorizationStatus {
      case .notDetermined: status = "notDetermined"
      case .denied: status = "denied"
      case .authorized: status = "authorized"
      case .provisional: status = "provisional"
      case .ephemeral: status = "ephemeral"
      @unknown default: status = "unknown"
      }
      invoke.resolve(["status": status])
    }
  }

  private func finish(_ result: RegistrationResult) {
    let asks = waiting
    waiting = []
    for invoke in asks {
      switch result {
      case .token(let token):
        invoke.resolve(["token": token, "environment": Self.environment])
      case .failure:
        // Apple's description is not passed on: only that it did not work.
        invoke.reject("push_token_unavailable")
      }
    }
  }

  /// A notice that arrives while myCarlos is in front is still shown as a banner.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler:
      @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list])
  }
}

@_cdecl("init_plugin_ios_push")
func initPlugin() -> Plugin {
  return PushPlugin()
}
