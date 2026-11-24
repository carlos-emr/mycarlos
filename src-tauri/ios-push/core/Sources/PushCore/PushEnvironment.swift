import Foundation

/// Which Apple push service this install's tokens belong to: `sandbox` for a development-signed
/// build and `production` for TestFlight and App Store builds. A token for one is refused by the
/// other, so this is read from what the build was actually signed with (its `aps-environment`
/// entitlement, in the embedded provisioning profile), never guessed from a debug flag.
public enum PushEnvironment {
  /// `profile` is the bytes of `embedded.mobileprovision` (a signed container around an XML property
  /// list), or `nil` when the build has none, as App Store builds do: that is `production`.
  public static func from(provisioningProfile profile: Data?) -> String {
    guard let profile, let entitlement = apsEnvironment(in: profile) else { return "production" }
    return entitlement == "development" ? "sandbox" : "production"
  }

  /// The `aps-environment` value inside the plist embedded in a provisioning profile, if any.
  static func apsEnvironment(in profile: Data) -> String? {
    // The XML property list sits in the clear between the container's binary header and signature.
    guard
      let start = profile.range(of: Data("<?xml".utf8)),
      let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex)
    else { return nil }
    let plist = profile.subdata(in: start.lowerBound..<end.upperBound)
    guard
      let object = try? PropertyListSerialization.propertyList(from: plist, format: nil),
      let root = object as? [String: Any],
      let entitlements = root["Entitlements"] as? [String: Any],
      let value = entitlements["aps-environment"] as? String
    else { return nil }
    return value
  }

  /// The running app's provisioning profile, or `nil` where the build has none.
  public static func current() -> String {
    let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision")
    return from(provisioningProfile: path.flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) })
  }
}
