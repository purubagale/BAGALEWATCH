import CoreLocation
import CoreTelephony
import Foundation
import UIKit

/// Turns "what's the phone's current network/location state" into one
/// `Sample` -- the iOS counterpart of Android's `CellSampleCollector.kt`,
/// reading fresh values at call time rather than caching, same as there.
///
/// WHY THIS IS SCOPED DOWN (read this before assuming feature parity with
/// Android): Android's `TelephonyManager.getAllCellInfo()` gives a
/// third-party app the serving cell ID, PCI, TAC, MCC/MNC, and
/// RSRP/RSRQ/RSSI/SINR for the actual serving cell. Apple's equivalent
/// framework, CoreTelephony, does NOT expose any of that to an ordinary
/// third-party app -- doing so requires a specific carrier entitlement
/// (`com.apple.CommCenter.fine-grained`, or similar) that Apple grants
/// directly to a carrier as a business relationship, not something
/// obtainable through app-side engineering effort. Absent that
/// entitlement (which this pilot does not have as of this writing), the
/// most this device can honestly report is:
///   - a one-shot GPS fix, via CoreLocation (parity with Android's
///     `FusedLocationProviderClient` one-shot request);
///   - a coarse network-GENERATION bucket (2G/3G/4G/5G), derived from
///     `CTTelephonyNetworkInfo.serviceCurrentRadioAccessTechnology`'s
///     RAT string -- this tells you "this device is on LTE" but not which
///     cell, and carries no signal-strength number at all;
///   - whether the active connection is Wi-Fi or cellular
///     (`NetworkMonitor`);
///   - a best-effort carrier name (see `readCarrierName()` below for why
///     "best-effort" is doing real work in that sentence).
/// No cell ID, no PCI/TAC, no RSRP/RSRQ/RSSI/SINR, no 2G RxQual, no 3G
/// RSCP/Ec-Io -- all of those stay `nil`/absent on every iOS sample,
/// permanently, not as a bug to fix later. This is Apple platform policy,
/// not a gap in this module.
final class TelemetrySampleCollector {
    private let identity: DeviceIdentity
    private let locationManager = CLLocationManager()
    private let telephonyInfo = CTTelephonyNetworkInfo()

    init(identity: DeviceIdentity) {
        self.identity = identity
        UIDevice.current.isBatteryMonitoringEnabled = true
    }

    /// - Parameter triggerReason: "periodic" | "manual" -- see `Sample.triggerReason`.
    /// - Returns: nil if not opted in, or if location permission has not been granted.
    func collect(triggerReason: String, completion: @escaping (Sample?) -> Void) {
        guard identity.optedIn else { completion(nil); return } // defense in depth, same as Android
        guard hasLocationPermission() else { completion(nil); return }

        readLocationWithTimeout { [weak self] location in
            guard let self else { completion(nil); return }
            let (networkType, connectionType) = self.readNetworkType()
            let sample = Sample(
                deviceId: self.identity.deviceId,
                timestampMs: Int64(Date().timeIntervalSince1970 * 1000),
                lat: location?.coordinate.latitude,
                lon: location?.coordinate.longitude,
                gpsAccuracyM: location.map { max($0.horizontalAccuracy, 0) },
                networkType: networkType,
                connectionType: connectionType.rawValue,
                carrierName: self.readCarrierName(),
                batteryPct: self.readBatteryPct(),
                triggerReason: triggerReason
            )
            completion(sample)
        }
    }

    private func hasLocationPermission() -> Bool {
        let status: CLAuthorizationStatus
        if #available(iOS 14.0, *) {
            status = locationManager.authorizationStatus
        } else {
            status = CLLocationManager.authorizationStatus()
        }
        return status == .authorizedWhenInUse || status == .authorizedAlways
    }

    /// A short-lived, best-effort location fetch -- not a continuous fix,
    /// same "keep GPS-on time minimal" intent as Android's one-shot
    /// `FusedLocationProviderClient` request. Uses a delegate shim
    /// (`OneShotLocationDelegate`) rather than `requestLocation()`'s
    /// fire-and-forget delegate callbacks directly, so this class can
    /// present a single completion handler with a timeout, matching the
    /// shape of Android's `suspendCancellableCoroutine` wrapper.
    private func readLocationWithTimeout(completion: @escaping (CLLocation?) -> Void) {
        let delegate = OneShotLocationDelegate(completion: completion)
        locationManager.delegate = delegate
        locationManager.desiredAccuracy = kCLLocationAccuracyBest
        // Keep the delegate alive for the duration of the request/timeout --
        // CLLocationManager holds it weakly-adjacent via a plain reference,
        // but this class doesn't otherwise retain it.
        objc_setAssociatedObject(locationManager, &AssociatedKeys.delegateKey, delegate, .OBJC_ASSOCIATION_RETAIN)
        delegate.start(on: locationManager, timeoutSeconds: 10)
    }

    /// Maps `CTTelephonyNetworkInfo`'s current radio access technology
    /// string to the SAME four-value vocabulary the backend already
    /// validates (`_NET_TYPES` in core/telemetry.py) -- "UNKNOWN" whenever
    /// on Wi-Fi (no cellular RAT applies) or the RAT can't be read.
    private func readNetworkType() -> (networkType: String, connectionType: NetworkMonitor.ConnectionType) {
        let connectionType = NetworkMonitor.shared.connectionType
        if connectionType == .wifi {
            return ("UNKNOWN", connectionType)
        }
        // Multi-SIM devices key this dictionary by radio "service" ID;
        // `serviceCurrentRadioAccessTechnology` was added for that reason
        // in iOS 12. `dataServiceIdentifier` picks the service actually
        // carrying data if available; otherwise just take any value
        // present, since a single-SIM Nepal Telecom device has exactly one.
        let ratsByService = telephonyInfo.serviceCurrentRadioAccessTechnology
        let rat: String?
        if #available(iOS 13.0, *), let dataId = telephonyInfo.dataServiceIdentifier {
            rat = ratsByService?[dataId] ?? ratsByService?.values.first
        } else {
            rat = ratsByService?.values.first
        }
        return (Self.bucket(forRadioAccessTechnology: rat), connectionType)
    }

    private static func bucket(forRadioAccessTechnology rat: String?) -> String {
        guard let rat else { return "UNKNOWN" }
        switch rat {
        case CTRadioAccessTechnologyGPRS, CTRadioAccessTechnologyEdge:
            return "GSM" // 2G
        case CTRadioAccessTechnologyWCDMA,
             CTRadioAccessTechnologyHSDPA,
             CTRadioAccessTechnologyHSUPA,
             CTRadioAccessTechnologyCDMA1x,
             CTRadioAccessTechnologyCDMAEVDORev0,
             CTRadioAccessTechnologyCDMAEVDORevA,
             CTRadioAccessTechnologyCDMAEVDORevB,
             CTRadioAccessTechnologyeHRPD:
            return "UMTS" // 3G -- Nepal Telecom's own network is GSM-family, but every WCDMA-family RAT string is mapped here regardless of which carrier reports it.
        case CTRadioAccessTechnologyLTE:
            return "LTE" // 4G
        default:
            if #available(iOS 14.1, *), rat == CTRadioAccessTechnologyNRNSA || rat == CTRadioAccessTechnologyNR {
                return "NR" // 5G (NSA anchored on LTE, or standalone)
            }
            return "UNKNOWN"
        }
    }

    /// Best-effort ONLY. `CTCarrier`/`CTTelephonyNetworkInfo.serviceSubscriberCellularProviders`
    /// were deprecated in iOS 16, and Apple's own release notes say the
    /// underlying values (`carrierName` included) may return a fixed
    /// placeholder rather than the real carrier on iOS 16+ for apps
    /// without a specific entitlement -- this is Apple deliberately
    /// locking the API down, not a bug in this collector. Treat any
    /// non-nil value here as "probably right on an older iOS/device, not
    /// guaranteed on a current one" -- verifying what a real, current
    /// pilot-target iOS version actually returns on a real Nepal Telecom
    /// SIM is exactly the kind of thing that needs a real device, flagged
    /// in the README's "Verification status" section same as everything
    /// else in this unbuilt module.
    private func readCarrierName() -> String? {
        guard #available(iOS 12.0, *) else { return nil }
        let providersByService = telephonyInfo.serviceSubscriberCellularProviders
        let carrier: CTCarrier?
        if #available(iOS 13.0, *), let dataId = telephonyInfo.dataServiceIdentifier {
            carrier = providersByService?[dataId] ?? providersByService?.values.first
        } else {
            carrier = providersByService?.values.first
        }
        guard let name = carrier?.carrierName, !name.isEmpty else { return nil }
        return name
    }

    private func readBatteryPct() -> Int? {
        let level = UIDevice.current.batteryLevel // 0.0-1.0, or -1.0 if unknown (e.g. simulator, monitoring not yet enabled)
        guard level >= 0 else { return nil }
        return Int((level * 100).rounded())
    }
}

private enum AssociatedKeys {
    static var delegateKey: UInt8 = 0
}

/// A tiny `CLLocationManagerDelegate` shim to get a single-shot,
/// timeout-bounded location fetch out of CoreLocation's delegate-callback
/// API -- functionally the same trade this module's Android sibling makes
/// with `suspendCancellableCoroutine` around
/// `FusedLocationProviderClient.getCurrentLocation`.
private final class OneShotLocationDelegate: NSObject, CLLocationManagerDelegate {
    private var completion: ((CLLocation?) -> Void)?
    private var timeoutWorkItem: DispatchWorkItem?

    init(completion: @escaping (CLLocation?) -> Void) {
        self.completion = completion
    }

    func start(on manager: CLLocationManager, timeoutSeconds: TimeInterval) {
        let workItem = DispatchWorkItem { [weak self, weak manager] in
            manager?.stopUpdatingLocation()
            self?.finish(with: nil)
        }
        timeoutWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds, execute: workItem)
        manager.requestLocation()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        finish(with: locations.last)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(with: nil)
    }

    private func finish(with location: CLLocation?) {
        timeoutWorkItem?.cancel()
        timeoutWorkItem = nil
        let cb = completion
        completion = nil
        cb?(location)
    }
}
