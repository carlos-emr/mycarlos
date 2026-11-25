import Foundation
import Security

/// What the app remembers between runs about the token the portal holds: a digest, never the token.
/// Kept in the Keychain, readable after the first unlock, on this device only (never in a backup
/// or iCloud). UNVERIFIED until macOS CI runs `swift test`.
public enum HandleKeychain {
  public static let defaultService = "ca.carlos.mycarlos.push-handle"

  private static func query(_ key: String, service: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  public static func read(_ key: String, service: String = defaultService) -> String? {
    var request = query(key, service: service)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &found) == errSecSuccess,
      let data = found as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  /// Keeps `value`, replacing what was there. False if the Keychain refused.
  @discardableResult
  public static func write(_ key: String, _ value: String, service: String = defaultService) -> Bool {
    delete(key, service: service)
    var item = query(key, service: service)
    item[kSecValueData as String] = Data(value.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }

  public static func delete(_ key: String, service: String = defaultService) {
    SecItemDelete(query(key, service: service) as CFDictionary)
  }
}
