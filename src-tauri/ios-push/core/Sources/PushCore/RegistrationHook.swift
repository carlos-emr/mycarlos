import Foundation
import ObjectiveC

/// What the system said when the app asked to register for remote notifications.
public enum RegistrationResult: Equatable {
  /// The device token, as lower-case hex.
  case token(String)
  /// Registration failed; the text is the system's description and is never shown to anyone.
  case failure(String)
}

/// Tauri does not hand the app delegate's registration callbacks to plugins, so this adds them to
/// the delegate's class at run time: the original method (if the class has one) still runs first,
/// then the result goes to `handler`. One class is hooked once, however many hooks ask.
public final class RegistrationHook {
  private static let tokenSelector = Selector(
    ("application:didRegisterForRemoteNotificationsWithDeviceToken:"))
  private static let failureSelector = Selector(
    ("application:didFailToRegisterForRemoteNotificationsWithError:"))
  private static var hooked = Set<ObjectIdentifier>()
  private static let lock = NSLock()

  private var handler: ((RegistrationResult) -> Void)?

  public init() {}

  /// Sends later results to `handler`. Returns false if `delegateClass` was already hooked by an
  /// earlier call (the earlier hook keeps its own handler).
  @discardableResult
  public func install(
    on delegateClass: AnyClass, handler: @escaping (RegistrationResult) -> Void
  ) -> Bool {
    Self.lock.lock()
    defer { Self.lock.unlock() }
    guard Self.hooked.insert(ObjectIdentifier(delegateClass)).inserted else { return false }
    self.handler = handler
    addTokenHook(to: delegateClass)
    addFailureHook(to: delegateClass)
    return true
  }

  private func addTokenHook(to cls: AnyClass) {
    let original = class_getInstanceMethod(cls, Self.tokenSelector).map(method_getImplementation)
    let block: @convention(block) (AnyObject, AnyObject, NSData) -> Void = {
      [weak self] object, application, token in
      if let original {
        typealias Call = @convention(c) (AnyObject, Selector, AnyObject, NSData) -> Void
        unsafeBitCast(original, to: Call.self)(object, Self.tokenSelector, application, token)
      }
      self?.handler?(.token(PushToken.hex(token as Data)))
    }
    replaceOrAdd(cls, Self.tokenSelector, imp_implementationWithBlock(block), original != nil)
  }

  private func addFailureHook(to cls: AnyClass) {
    let original = class_getInstanceMethod(cls, Self.failureSelector).map(method_getImplementation)
    let block: @convention(block) (AnyObject, AnyObject, NSError) -> Void = {
      [weak self] object, application, error in
      if let original {
        typealias Call = @convention(c) (AnyObject, Selector, AnyObject, NSError) -> Void
        unsafeBitCast(original, to: Call.self)(object, Self.failureSelector, application, error)
      }
      self?.handler?(.failure(error.localizedDescription))
    }
    replaceOrAdd(cls, Self.failureSelector, imp_implementationWithBlock(block), original != nil)
  }

  private func replaceOrAdd(_ cls: AnyClass, _ selector: Selector, _ imp: IMP, _ existed: Bool) {
    if existed, let method = class_getInstanceMethod(cls, selector) {
      method_setImplementation(method, imp)
    } else {
      // "v@:@@": returns nothing; takes self, the selector and two objects.
      class_addMethod(cls, selector, imp, "v@:@@")
    }
  }
}
