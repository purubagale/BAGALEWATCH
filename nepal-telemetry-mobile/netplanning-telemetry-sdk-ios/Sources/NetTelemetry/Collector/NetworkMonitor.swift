import Foundation
import Network

/// Thin wrapper on `Network.framework`'s `NWPathMonitor` answering "is the
/// device currently on Wi-Fi or cellular" -- iOS has no per-request
/// `NetworkType.UNMETERED` constraint the way Android's WorkManager
/// `Constraints` does, so `SamplingScheduler`'s upload task checks this
/// itself before an upload runs when `TelemetryConfig.uploadOnlyOnUnmetered`
/// is true.
///
/// `NWPathMonitor` delivers updates asynchronously on its own queue; this
/// class keeps the latest snapshot in a lock-protected property so callers
/// (`TelemetrySampleCollector`, `SamplingScheduler`) can read it
/// synchronously without awaiting a callback each time, same ergonomics as
/// a plain synchronous getter.
final class NetworkMonitor {
    static let shared = NetworkMonitor()

    enum ConnectionType: String {
        case wifi
        case cellular
        case unknown
    }

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "np.nepaltelecom.telemetry.networkmonitor")
    private let lock = NSLock()
    private var _connectionType: ConnectionType = .unknown
    private var _isUnmetered = false

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let type: ConnectionType
            if path.usesInterfaceType(.wifi) {
                type = .wifi
            } else if path.usesInterfaceType(.cellular) {
                type = .cellular
            } else if path.status == .satisfied {
                // Wired/other -- treat as unmetered same as Wi-Fi for the upload gate.
                type = .wifi
            } else {
                type = .unknown
            }
            self.lock.lock()
            self._connectionType = type
            // isConstrained covers Low Data Mode; isExpensive covers
            // cellular and personal hotspot -- both are "don't burn the
            // subscriber's data/battery budget" signals, same intent as
            // Android's NetworkType.UNMETERED.
            self._isUnmetered = path.status == .satisfied && !path.isExpensive && !path.isConstrained
            self.lock.unlock()
        }
        monitor.start(queue: monitorQueue)
    }

    var connectionType: ConnectionType {
        lock.lock(); defer { lock.unlock() }
        return _connectionType
    }

    var isUnmetered: Bool {
        lock.lock(); defer { lock.unlock() }
        return _isUnmetered
    }
}
