import Foundation
import EZPixel

guard let key = ProcessInfo.processInfo.environment["EZCODER_PIXEL_KEY"] else {
    print("set EZCODER_PIXEL_KEY=pk_live_...")
    exit(1)
}

EZPixel.shared.initialize(projectKey: key)

// Manual report
EZPixel.shared.report("swift-smoke: manual report from main.swift")

// captureError with a thrown error
struct ValidationError: Error, CustomStringConvertible {
    let description: String
}
do {
    throw ValidationError(description: "swift-smoke: caught ValidationError")
} catch {
    EZPixel.shared.captureError(error)
}

// Give the async URLSession dataTask time to flush before raising.
Thread.sleep(forTimeInterval: 1.0)

// Now crash via NSException — uncaught, should hit our sync handler before exit.
NSException(
    name: NSExceptionName("ValidationCrash"),
    reason: "swift-smoke: REAL UNCAUGHT NSException via raise()",
    userInfo: nil
).raise()
