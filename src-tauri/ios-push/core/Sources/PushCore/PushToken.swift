import Foundation

/// The text of an Apple device token, as the portal takes it: 64 to 200 lower-case hexadecimal
/// characters (the portal also accepts upper case and stores it lower-cased).
public enum PushToken {
  /// The token's bytes as lower-case hex.
  public static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  /// Whether `text` is something the portal would accept as a token.
  public static func isValid(_ text: String) -> Bool {
    guard (64...200).contains(text.utf8.count) else { return false }
    return text.utf8.allSatisfy {
      ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) || ($0 >= 0x41 && $0 <= 0x46)
    }
  }
}
