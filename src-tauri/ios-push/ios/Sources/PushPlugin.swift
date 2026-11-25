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
  /// The asks that wait for Apple's answer, each with its own number so that its own timer can end
  /// it alone. Only touched on the main queue.
  private var waiting: [(id: UUID, invoke: Invoke)] = []
  /// How long to wait for Apple before giving up.
  private static let patience: TimeInterval = 30

  /// Which Apple push service this build's tokens belong to, from what it was signed with.
  private static var environment: String { PushEnvironment.current() }

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
        let id = UUID()
        self.waiting.append((id: id, invoke: invoke))
        UIApplication.shared.registerForRemoteNotifications()
        // This ask's own timer: it ends this ask only, not one that came later.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.patience) {
          self.timeOut(id)
        }
      }
    }
  }

  private struct HandleArgs: Decodable {
    let key: String
    let value: String?
  }

  /// What the Keychain holds for this destination, if anything (the digest of the bound token).
  @objc public func recallHandle(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HandleArgs.self)
    invoke.resolve(["value": HandleKeychain.read(args.key) as Any])
  }

  @objc public func rememberHandle(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HandleArgs.self)
    guard let value = args.value, HandleKeychain.write(args.key, value) else {
      invoke.reject("push_handle_not_kept")
      return
    }
    invoke.resolve()
  }

  @objc public func forgetHandle(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HandleArgs.self)
    HandleKeychain.delete(args.key)
    invoke.resolve()
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

  /// Apple answered: every ask that is waiting gets the answer.
  private func finish(_ result: RegistrationResult) {
    let asks = waiting
    waiting = []
    for ask in asks {
      switch result {
      case .token(let token):
        ask.invoke.resolve(["token": token, "environment": Self.environment])
      case .failure:
        // Apple's description is not passed on: only that it did not work.
        ask.invoke.reject("push_token_unavailable")
      }
    }
  }

  /// One ask ran out of patience. If it is still waiting it is refused, and the others wait on.
  private func timeOut(_ id: UUID) {
    guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
    let ask = waiting.remove(at: index)
    ask.invoke.reject("push_token_timeout")
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
