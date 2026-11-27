// swift-tools-version:5.3
// The Tauri plugin half: its logic that needs no Tauri lives in ../core (PushCore), which has
// its own tests (`swift test --package-path src-tauri/ios-push/core`, on a Mac).
import PackageDescription

let package = Package(
  name: "tauri-plugin-ios-push",
  platforms: [
    .macOS(.v10_15),
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "tauri-plugin-ios-push",
      type: .static,
      targets: ["tauri-plugin-ios-push"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(name: "PushCore", path: "../core"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-ios-push",
      dependencies: [
        .byName(name: "Tauri"),
        .byName(name: "PushCore"),
      ],
      path: "Sources")
  ]
)
