// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-ios-pdf",
    platforms: [.iOS(.v13)],
    products: [.library(name: "tauri-plugin-ios-pdf", type: .static,
                        targets: ["tauri-plugin-ios-pdf"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-ios-pdf", dependencies: [.byName(name: "Tauri")],
                      path: "Sources")]
)
