import Foundation
import UIKit

/// Public entry point -- the entire surface the host app needs to call,
/// deliberately mirroring Android's `NetTelemetry.kt` object method for
/// method (init/optIn/optOut/isOptedIn/getStatus/sampleNow/uploadNow, plus
/// the rescue/drive-test-consent lanes) so a developer who already
/// integrated the Android SDK finds the same shape here. No UI anywhere
/// in this module, same as Android.
///
/// TWO integration steps this SDK needs that Android's doesn't, both
/// REQUIRED before `initialize(config:)` is useful -- see
/// ../../ios-demo-app/README.md for exactly where to put these:
///   1. Call `registerBackgroundTasks()` before the host app finishes
///      launching (its `App` struct's `init()`, or
///      `AppDelegate.application(_:didFinishLaunchingWithOptions:)`).
///      This is BGTaskScheduler's hard requirement, not a style choice --
///      registering a task identifier after launch has completed crashes
///      at the next scheduling attempt. This is iOS's version of the same
///      lesson Android's README already calls out for a different reason
///      ("call init() from Application.onCreate, not an Activity").
///   2. List both task identifiers
///      (`SamplingScheduler.samplingTaskIdentifier`/`.uploadTaskIdentifier`)
///      under `BGTaskSchedulerPermittedIdentifiers` in Info.plist, and add
///      `UIBackgroundModes` -> `processing` (and `fetch` on older iOS).
public enum NetTelemetry {
    private static var config: TelemetryConfig?
    private static var scheduler: SamplingScheduler?
    private static var foregroundObserversRegistered = false
    private static let batchSize = 200

    public static func initialize(config: TelemetryConfig) {
        self.config = config
        let identity = DeviceIdentity()
        // First-run seeding: only when this device/install has NEVER
        // stored an explicit opt-in choice, and only when the host app
        // opted into an opt-out model via TelemetryConfig.defaultOptIn --
        // see that field's doc comment. hasExplicitOptInState guards this
        // so it can never fire again after the very first initialize()
        // on an install, even if a later app update changes defaultOptIn:
        // a subscriber's own later optIn()/optOut() always wins from then on.
        if !identity.hasExplicitOptInState && config.defaultOptIn {
            identity.optedIn = true
        }
        let scheduler = SamplingScheduler(identity: identity, config: config)
        Self.scheduler = scheduler
        registerForegroundObservers()
        if identity.optedIn {
            scheduler.scheduleBackgroundWork()
            startForegroundTimerIfActive()
        }
    }

    /// See this type's header comment -- must be called once, before the
    /// host app finishes launching, and before `initialize(config:)`.
    public static func registerBackgroundTasks() {
        SamplingScheduler.registerTaskHandlers(
            sample: { done in runScheduledSample(completion: done) },
            upload: { done in runScheduledUpload(completion: done) }
        )
    }

    public static func optIn() {
        precondition(config != nil, "NetTelemetry.initialize(config:) must be called before optIn()")
        let identity = DeviceIdentity()
        identity.optedIn = true
        scheduler?.scheduleBackgroundWork()
        startForegroundTimerIfActive()
    }

    public static func optOut(wipeQueuedData: Bool = true) {
        precondition(config != nil, "NetTelemetry.initialize(config:) must be called before optOut()")
        let identity = DeviceIdentity()
        identity.optedIn = false
        scheduler?.cancelBackgroundWork()
        scheduler?.stopForegroundTimer()
        if wipeQueuedData { SampleQueue().clear() }
    }

    public static func isOptedIn() -> Bool {
        DeviceIdentity().optedIn
    }

    public static func getStatus() -> TelemetryStatus {
        let identity = DeviceIdentity()
        let queue = SampleQueue()
        return TelemetryStatus(
            optedIn: identity.optedIn,
            queuedSampleCount: queue.size(),
            lastSampleAtMs: queue.lastSampleAtMs(),
            // Left nil for the host app to track via its own upload
            // observer if it wants finer detail -- same as Android.
            lastUploadAttemptAtMs: nil
        )
    }

    /// Optional: lets the host app trigger an immediate, foreground sample
    /// -- e.g. its own "check my signal now" button. Not required for
    /// automatic collection, which runs on its own schedule (subject to
    /// this whole SDK's background-timing caveats -- see
    /// SamplingScheduler.swift).
    public static func sampleNow() {
        guard isOptedIn() else { return }
        let identity = DeviceIdentity()
        DispatchQueue.main.async {
            TelemetrySampleCollector(identity: identity).collect(triggerReason: "manual") { sample in
                if let sample { SampleQueue().append(sample) }
            }
        }
    }

    /// Optional: triggers an immediate upload attempt instead of waiting
    /// for the scheduled background task. Unlike the scheduled upload,
    /// this does NOT wait for an unmetered connection even if
    /// `TelemetryConfig.uploadOnlyOnUnmetered` is true -- same exception
    /// Android's `uploadNow()` makes, for the same reason (an explicit
    /// manual action bypassing the automatic data-saving default is the
    /// normal expectation here, and is what makes this useful for testing
    /// against a real backend regardless of which network the test device
    /// happens to be on).
    public static func uploadNow() {
        guard isOptedIn(), let config else { return }
        flushQueue(config: config, respectUnmeteredSetting: false) { _ in }
    }

    /// Registers this device for the rescue-location lane -- see
    /// `TelemetryConfig.rescueEnrollUrl`'s doc comment and Android's
    /// `enrollForRescue`, which this mirrors exactly (including: this
    /// call alone has no effect on a device not also opted into regular
    /// sampling via `optIn`; it's on the host app's consent UI to make
    /// that dependency clear).
    public static func enrollForRescue(msisdn: String) {
        guard let url = config?.rescueEnrollUrl else {
            fatalError("TelemetryConfig.rescueEnrollUrl must be set to use rescue enrollment")
        }
        let deviceId = DeviceIdentity().deviceId
        RescueApi(endpointUrl: url, apiKey: config?.apiKey)
            .enroll(deviceId: deviceId, consent: true, msisdn: msisdn) { _ in }
    }

    /// Withdraws rescue-location consent -- see Android's `optOutOfRescue`.
    /// Does NOT affect general telemetry opt-in/out; call `optOut`
    /// separately for both.
    public static func optOutOfRescue() {
        guard let url = config?.rescueEnrollUrl else {
            fatalError("TelemetryConfig.rescueEnrollUrl must be set to use rescue enrollment")
        }
        let deviceId = DeviceIdentity().deviceId
        RescueApi(endpointUrl: url, apiKey: config?.apiKey)
            .enroll(deviceId: deviceId, consent: false, msisdn: nil) { _ in }
    }

    /// Records standing consent to inclusion in a consent-gated
    /// drive-test/coverage session -- see Android's `setDriveTestConsent`.
    /// Independent of `optIn`/`enrollForRescue`.
    public static func setDriveTestConsent(_ consent: Bool) {
        guard let url = config?.driveTestConsentUrl else {
            fatalError("TelemetryConfig.driveTestConsentUrl must be set to use drive-test consent")
        }
        let deviceId = DeviceIdentity().deviceId
        DriveTestConsentApi(apiKey: config?.apiKey)
            .setConsent(endpointUrl: url, deviceId: deviceId, consent: consent) { _ in }
    }

    /// Fetches the current subscriber-facing drive-test consent copy --
    /// see Android's `fetchDriveTestConsentMessage`. Delivers `nil`
    /// (never throws) when unconfigured or on any fetch failure;
    /// `completion` is always called on the main thread.
    public static func fetchDriveTestConsentMessage(completion: @escaping (String?) -> Void) {
        guard let url = config?.driveTestConsentMessageUrl else {
            completion(nil)
            return
        }
        DriveTestConsentApi(apiKey: config?.apiKey).fetchMessage(endpointUrl: url) { message in
            DispatchQueue.main.async { completion(message) }
        }
    }

    // MARK: - Foreground timer wiring

    private static func registerForegroundObservers() {
        guard !foregroundObserversRegistered else { return }
        foregroundObserversRegistered = true
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in startForegroundTimerIfActive() }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in scheduler?.stopForegroundTimer() }
    }

    private static func startForegroundTimerIfActive() {
        guard isOptedIn(), let scheduler, UIApplication.shared.applicationState == .active else { return }
        scheduler.startForegroundTimer {
            let identity = DeviceIdentity()
            DispatchQueue.main.async {
                TelemetrySampleCollector(identity: identity).collect(triggerReason: "periodic") { sample in
                    if let sample { SampleQueue().append(sample) }
                }
            }
        }
    }

    // MARK: - BGTask handlers

    private static func runScheduledSample(completion: @escaping () -> Void) {
        // Reschedule the next tick immediately -- BGTaskScheduler requests
        // are one-shot (unlike Android's PeriodicWorkRequest), so this is
        // what makes "periodic" happen at all.
        scheduler?.scheduleSamplingTask()
        guard config != nil, DeviceIdentity().optedIn else { completion(); return }
        let identity = DeviceIdentity()
        DispatchQueue.main.async {
            TelemetrySampleCollector(identity: identity).collect(triggerReason: "periodic") { sample in
                if let sample { SampleQueue().append(sample) }
                completion()
            }
        }
    }

    private static func runScheduledUpload(completion: @escaping () -> Void) {
        scheduler?.scheduleUploadTask() // reschedule next tick immediately, same reasoning as sampling above
        guard let config, DeviceIdentity().optedIn else { completion(); return }
        flushQueue(config: config, respectUnmeteredSetting: config.uploadOnlyOnUnmetered) { _ in completion() }
    }

    // MARK: - Upload draining

    private static func flushQueue(config: TelemetryConfig, respectUnmeteredSetting: Bool, completion: @escaping (Bool) -> Void) {
        if respectUnmeteredSetting && !NetworkMonitor.shared.isUnmetered {
            completion(false) // leave the queue alone -- the next scheduled attempt (or a manual uploadNow()) tries again
            return
        }
        let queue = SampleQueue()
        let api = TelemetryApi(endpointUrl: config.endpointUrl, apiKey: config.apiKey)
        uploadNextBatch(queue: queue, api: api, uploadedAny: false, completion: completion)
    }

    /// Uploads in bounded batches, same `BATCH_SIZE` as Android's
    /// `UploadWorker.kt`, so one slow/huge queue doesn't become one giant,
    /// easily-interrupted request.
    private static func uploadNextBatch(queue: SampleQueue, api: TelemetryApi, uploadedAny: Bool, completion: @escaping (Bool) -> Void) {
        let batch = queue.peek(limit: batchSize)
        guard !batch.isEmpty else { completion(true); return }
        api.uploadBatch(batch) { result in
            guard result.accepted else {
                // Leave this batch queued; try again on the next scheduled
                // cycle (or uploadNow()) rather than looping on a dead
                // network right now -- same as Android.
                completion(uploadedAny)
                return
            }
            queue.remove(batch)
            if result.remoteOptOutRequested {
                // The backend asked THIS device to opt itself out -- see
                // TelemetryApi.swift's doc comment. Same exact effect as a
                // subscriber tapping "opt out" themselves; stop draining
                // the rest of the queue too, same as Android.
                optOut()
                completion(true)
                return
            }
            if batch.count < batchSize {
                completion(true) // that was the last partial batch
                return
            }
            uploadNextBatch(queue: queue, api: api, uploadedAny: true, completion: completion)
        }
    }
}
