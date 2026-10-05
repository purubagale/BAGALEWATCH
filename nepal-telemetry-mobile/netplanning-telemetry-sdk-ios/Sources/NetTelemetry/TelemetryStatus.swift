import Foundation

/// Read-only snapshot for the host app's own UI -- direct counterpart of
/// Android's `TelemetryStatus.kt`.
public struct TelemetryStatus {
    public let optedIn: Bool
    public let queuedSampleCount: Int
    public let lastSampleAtMs: Int64?
    public let lastUploadAttemptAtMs: Int64?
}
