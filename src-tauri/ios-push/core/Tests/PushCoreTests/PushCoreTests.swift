import XCTest

@testable import PushCore

final class PushTokenTests: XCTestCase {
  func testTheTokenIsLowerCaseHex() {
    XCTAssertEqual(PushToken.hex(Data([0x00, 0x0f, 0xa0, 0xff])), "000fa0ff")
    XCTAssertEqual(PushToken.hex(Data()), "")
  }

  func testOnlyHexOfTheRightLengthIsValid() {
    let good = String(repeating: "ab", count: 32)  // 64 characters
    XCTAssertTrue(PushToken.isValid(good))
    XCTAssertTrue(PushToken.isValid(good.uppercased()))
    XCTAssertTrue(PushToken.isValid(String(repeating: "0", count: 200)))
    XCTAssertFalse(PushToken.isValid(String(repeating: "a", count: 63)))
    XCTAssertFalse(PushToken.isValid(String(repeating: "a", count: 201)))
    XCTAssertFalse(PushToken.isValid(String(repeating: "g", count: 64)))
    XCTAssertFalse(PushToken.isValid(good + " "))
    XCTAssertFalse(PushToken.isValid(""))
  }
}

/// A class that already answers the token callback, as an app delegate may.
final class ImplementsBoth: NSObject {
  var originalSaw: [String] = []

  @objc(application:didRegisterForRemoteNotificationsWithDeviceToken:)
  dynamic func didRegister(_ application: AnyObject, token: Data) {
    originalSaw.append("token")
  }

  @objc(application:didFailToRegisterForRemoteNotificationsWithError:)
  dynamic func didFail(_ application: AnyObject, error: NSError) {
    originalSaw.append("failure")
  }
}

/// A class with neither callback.
final class ImplementsNeither: NSObject {}

/// A class that answers only the failure callback.
final class ImplementsFailureOnly: NSObject {
  var saw = false

  @objc(application:didFailToRegisterForRemoteNotificationsWithError:)
  dynamic func didFail(_ application: AnyObject, error: NSError) { saw = true }
}

/// A class hooked twice, to see that the second asking is refused.
final class Once: NSObject {}

final class RegistrationHookTests: XCTestCase {
  private let token = Data(repeating: 0xab, count: 32)

  func testTheOriginalRunsAndThenTheHandlerGetsTheToken() {
    let hook = RegistrationHook()
    var got: [RegistrationResult] = []
    XCTAssertTrue(hook.install(on: ImplementsBoth.self) { got.append($0) })
    let object = ImplementsBoth()
    object.didRegister(NSObject(), token: token)
    XCTAssertEqual(object.originalSaw, ["token"])
    XCTAssertEqual(got, [.token(String(repeating: "ab", count: 32))])
  }

  func testAFailureReachesTheHandlerAfterTheOriginal() {
    let hook = RegistrationHook()
    var got: [RegistrationResult] = []
    hook.install(on: ImplementsFailureOnly.self) { got.append($0) }
    let object = ImplementsFailureOnly()
    object.didFail(NSObject(), error: NSError(domain: "FAKE", code: 3))
    XCTAssertTrue(object.saw)
    XCTAssertEqual(got.count, 1)
    if case .failure = got[0] {} else { XCTFail("expected a failure") }
  }

  func testAClassWithNoCallbackGetsOneAdded() {
    let hook = RegistrationHook()
    var got: [RegistrationResult] = []
    hook.install(on: ImplementsNeither.self) { got.append($0) }
    let object = ImplementsNeither()
    let selector = Selector(("application:didRegisterForRemoteNotificationsWithDeviceToken:"))
    XCTAssertTrue(object.responds(to: selector))
    _ = object.perform(selector, with: NSObject(), with: token as NSData)
    XCTAssertEqual(got, [.token(String(repeating: "ab", count: 32))])
  }

  func testAClassIsHookedOnlyOnce() {
    let first = RegistrationHook()
    let second = RegistrationHook()
    XCTAssertTrue(first.install(on: Once.self) { _ in })
    XCTAssertFalse(second.install(on: Once.self) { _ in })
  }
}
