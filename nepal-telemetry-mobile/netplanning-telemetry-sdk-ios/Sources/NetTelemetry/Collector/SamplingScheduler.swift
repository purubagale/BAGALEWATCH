import BackgroundTasks
import Foundation
import UIKit

/// Schedules and runs both background work items (periodic sampling,
/// periodic upload) plus the foreground-only timer that stands in for
/// Android's handover-triggered listener. This is the module's single
/// biggest structural departure from Android, because the underlying OS
/// capability it's built on is fundamentally weaker -- read this whole
/// comment before assuming this behaves like `NetTelemetry.kt`'s
/// `scheduleBackgroundWork()`/`HandoverListener`.
///
/// Android's WorkManager guarantees roughly-on-schedule execution (a
/// 15-minute floor, then it really does run close to that cadence,
/// process-killed-and-relaunched or not) because the OS is designed to
/// let scheduled background work run. iOS's `BGTaskScheduler` makes NO
/// such promise: `BGAppRefreshTaskRequest`/`BGProcessingTaskRequest` only
/// tell iOS the EARLIEST time a task may run -- iOS then runs it whenever
/// its own heuristics (recent app usage, battery level, Low Power Mode,
/// whether the device is charging/idle overnight for a `BGProcessingTask`)
/// decide to, which can be minutes late, many hours late, or -- for an app
/// a subscriber opens rarely -- effectively never. There is no
/// entitlement or setting this SDK can use to force Android-like
/// reliability; this is Apple platform policy for every third-party app,
/// not a gap to fix here. A pilot relying on this for anything
/// time-sensitive needs to know its background cadence is best-effort,
/// full stop.
///
/// Two task identifiers are registered (must also be listed in the host
/// app's Info.plist under `BGTaskSchedulerPermittedIdentifiers` -- see
/// ../../ios-demo-app/README.md):
///   - `samplingTaskIdentifier`: a `BGAppRefreshTask` (short-budget, ~30s)
///     that takes one sample and queues it.
///   - `uploadTaskIdentifier`: a `BGProcessingTask` (longer-budget,
///     network-requiring) that flushes the queue, honouring
///     `TelemetryConfig.uploadOnlyOnUnmetered` via `NetworkMonitor`.
/// Both self-reschedule at the end of every run (success or failure) --
/// `BGTaskScheduler` requests are one-shot, unlike WorkManager's
/// PeriodicWorkRequest, so "periodic" here is simulated by each run
/// scheduling the next one.
final class SamplingScheduler {
    static let samplingTaskIdentifier = "np.nepaltelecom.telemetry.sampling"
    static let uploadTaskIdentifier = "np.nepaltelecom.telemetry.upload"

    private let identity: DeviceIdentity
    private var config: TelemetryConfig
    private var foregroundTimer: DispatchSourceTimer?
    private let foregroundQueue = DispatchQueue(label: "np.nepaltelecom.telemetry.foregroundtimer")

    init(identity: DeviceIdentity, config: TelemetryConfig) {
        self.identity = identity
        self.config = config
    }

    func updateConfig(_ config: TelemetryConfig) {
        self.config = config
    }

    /// MUST be called before the app finishes launching (from the host
    /// app's `Application`/`@main App` init, or `AppDelegate
    /// .application(_:didFinishLaunchingWithOptions:)`) -- registering a
    /// BGTask identifier after launch has completed is a documented
    /// programmer error that crashes at the next scheduling attempt. This
    /// is iOS's version of the exact same lesson Android's README already
    /// calls out for a different reason ("call init() from
    /// Application.onCreate, not an Activity") -- different mechanism,
    /// same shape of mistake to avoid.
    static func registerTaskHandlers(sample: @escaping (@escaping () -> Void) -> Void,
                                      upload: @escaping (@escaping () -> Void) -> Void) {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: samplingTaskIdentifier, using: nil) { task in
            task.expirationHandler = { task.setTaskCompleted(success: false) }
            sample { task.setTaskCompleted(success: true) }
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: uploadTaskIdentifier, using: nil) { task in
            task.expirationHandler = { task.setTaskCompleted(success: false) }
            upload { task.setTaskCompleted(success: true) }
        }
    }

    func scheduleBackgroundWork() {
        scheduleSamplingTask()
        scheduleUploadTask()
    }

    func cancelBackgroundWork() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.samplingTaskIdentifier)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.uploadTaskIdentifier)
    }

    func scheduleSamplingTask() {
        let request = BGAppRefreshTaskRequest(identifier: Self.samplingTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: config.samplingIntervalMinutes * 60)
        try? BGTaskScheduler.shared.submit(request) // throws only if BGTaskSchedulerPermittedIdentifiers is misconfigured -- nothing useful to do at runtime but skip this cycle
    }

    func scheduleUploadTask() {
        let request = BGProcessingTaskRequest(identifier: Self.uploadTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: config.uploadIntervalMinutes * 60)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        try? BGTaskScheduler.shared.submit(request)
    }

    // MARK: - Foreground timer (stand-in for Android's handover listener)

    /// Starts a plain repeating timer, active only while the app is in the
    /// foreground -- see this file's header comment and
    /// `TelemetryConfig.foregroundSampleIntervalSeconds` for why this
    /// exists instead of a real handover-change callback (iOS exposes
    /// none to third-party apps). `onTick` is called on `foregroundQueue`.
    func startForegroundTimer(onTick: @escaping () -> Void) {
        stopForegroundTimer()
        let timer = DispatchSource.makeTimerSource(queue: foregroundQueue)
        timer.schedule(
            deadline: .now() + config.foregroundSampleIntervalSeconds,
            repeating: config.foregroundSampleIntervalSeconds
        )
        timer.setEventHandler(handler: onTick)
        timer.resume()
        foregroundTimer = timer
    }

    func stopForegroundTimer() {
        foregroundTimer?.cancel()
        foregroundTimer = nil
    }
}
