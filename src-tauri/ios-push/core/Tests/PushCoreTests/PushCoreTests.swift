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

/// A class that answers the token callback, and one that only inherits it.
class ParentDelegate: NSObject {
  var parentSaw = 0

  @objc(application:didRegisterForRemoteNotificationsWithDeviceToken:)
  dynamic func didRegister(_ application: AnyObject, token: Data) { parentSaw += 1 }
}
final class ChildDelegate: ParentDelegate {}

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

  func testHookingASubclassLeavesItsSuperclassAlone() {
    let hook = RegistrationHook()
    var got: [RegistrationResult] = []
    hook.install(on: ChildDelegate.self) { got.append($0) }
    let child = ChildDelegate()
    child.didRegister(NSObject(), token: token)
    // The inherited method still ran, and then the handler heard.
    XCTAssertEqual(child.parentSaw, 1)
    XCTAssertEqual(got, [.token(String(repeating: "ab", count: 32))])
    // The superclass's own instances are not hooked: its method is what it was.
    let parent = ParentDelegate()
    parent.didRegister(NSObject(), token: token)
    XCTAssertEqual(parent.parentSaw, 1)
    XCTAssertEqual(got.count, 1)
  }

  func testAClassIsHookedOnlyOnce() {
    let first = RegistrationHook()
    let second = RegistrationHook()
    XCTAssertTrue(first.install(on: Once.self) { _ in })
    XCTAssertFalse(second.install(on: Once.self) { _ in })
  }
}

final class PushEnvironmentTests: XCTestCase {
  /// A provisioning profile is a signed container: binary bytes, then an XML plist, then more bytes.
  private func profile(_ entitlements: String) -> Data {
    let plist = """
      <?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0"><dict><key>Name</key><string>FAKE</string>
      <key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>
      """
    return Data([0x30, 0x82, 0x01, 0x00]) + Data(plist.utf8) + Data([0xde, 0xad, 0xbe, 0xef])
  }

  func testADevelopmentProfileIsTheSandbox() {
    let data = profile("<key>aps-environment</key><string>development</string>")
    XCTAssertEqual(PushEnvironment.from(provisioningProfile: data), "sandbox")
  }

  func testAProductionProfileIsProduction() {
    let data = profile("<key>aps-environment</key><string>production</string>")
    XCTAssertEqual(PushEnvironment.from(provisioningProfile: data), "production")
  }

  func testNoProfileOrNoEntitlementOrGarbageIsProduction() {
    XCTAssertEqual(PushEnvironment.from(provisioningProfile: nil), "production")
    XCTAssertEqual(
      PushEnvironment.from(provisioningProfile: profile("<key>other</key><true/>")), "production")
    XCTAssertEqual(
      PushEnvironment.from(provisioningProfile: Data("not a profile".utf8)), "production")
    XCTAssertEqual(PushEnvironment.from(provisioningProfile: Data()), "production")
  }

  func testKeychainKeepsReplacesAndForgetsAValue() {
    let service = "ca.carlos.mycarlos.test-\(UUID().uuidString)"
    let key = "FAKE-destination"
    defer { HandleKeychain.delete(key, service: service) }
    XCTAssertNil(HandleKeychain.read(key, service: service))
    XCTAssertTrue(HandleKeychain.write(key, "aa", service: service))
    XCTAssertEqual(HandleKeychain.read(key, service: service), "aa")
    XCTAssertTrue(HandleKeychain.write(key, "bb", service: service))
    XCTAssertEqual(HandleKeychain.read(key, service: service), "bb")
    HandleKeychain.delete(key, service: service)
    XCTAssertNil(HandleKeychain.read(key, service: service))
  }
}
