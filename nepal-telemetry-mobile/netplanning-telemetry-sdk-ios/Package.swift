// swift-tools-version:5.9
// Swift Package wrapping the iOS counterpart of ../netplanning-telemetry-sdk
// (the Android module). A Swift Package rather than a hand-written .xcodeproj
// on purpose: an .xcodeproj is a fragile binary-ish plist format that is very
// easy to get subtly wrong by hand with no Xcode available to open/validate
// it (see this repo's own no-Android-SDK situation for the Kotlin module --
// same limitation, this is the iOS-appropriate way around it). A Swift
// Package needs no such file, is added to a host Xcode project with
// File > Add Package Dependencies... > Add Local..., and is what
// ../ios-demo-app/README.md tells you to do with this folder.
import PackageDescription

let package = Package(
    name: "NetTelemetry",
    platforms: [
        .iOS(.v14), // CTTelephonyNetworkInfo.serviceCurrentRadioAccessTechnology, BGTaskScheduler, NWPathMonitor all predate iOS 14 -- picked as a conservative modern floor, not because anything here needs exactly 14.
    ],
    products: [
        .library(name: "NetTelemetry", targets: ["NetTelemetry"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "NetTelemetry",
            dependencies: [],
            path: "Sources/NetTelemetry"
        ),
    ]
)
