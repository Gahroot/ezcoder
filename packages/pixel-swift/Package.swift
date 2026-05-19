// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "EZPixel",
    platforms: [
        .iOS(.v13),
        .macOS(.v10_15),
        .tvOS(.v13),
        .watchOS(.v6),
    ],
    products: [
        .library(name: "EZPixel", targets: ["EZPixel"]),
        .executable(name: "ezpixel-smoke", targets: ["EZPixelSmoke"]),
    ],
    targets: [
        .target(
            name: "EZPixel",
            path: "Sources/EZPixel"
        ),
        .executableTarget(
            name: "EZPixelSmoke",
            dependencies: ["EZPixel"],
            path: "Sources/EZPixelSmoke"
        ),
        .testTarget(
            name: "EZPixelTests",
            dependencies: ["EZPixel"],
            path: "Tests/EZPixelTests"
        ),
    ]
)
