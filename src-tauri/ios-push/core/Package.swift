// swift-tools-version:5.5
// PushCore: the parts of the iPhone push registration that need no Tauri, so that they can be
// tested on any Mac with `swift test`: the token text and the app-delegate hook.
import PackageDescription

let package = Package(
  name: "PushCore",
  platforms: [
    .macOS(.v10_15),
    .iOS(.v14),
  ],
  products: [
    .library(name: "PushCore", type: .static, targets: ["PushCore"])
  ],
  targets: [
    .target(name: "PushCore", path: "Sources/PushCore"),
    .testTarget(name: "PushCoreTests", dependencies: ["PushCore"], path: "Tests/PushCoreTests"),
  ]
)
