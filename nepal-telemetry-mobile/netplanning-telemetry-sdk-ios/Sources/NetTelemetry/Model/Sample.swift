import Foundation

/// One reading -- the iOS counterpart of Android's `Sample.kt`, deliberately
/// reduced in scope. Per the 2026-09-10 scoping decision, this device
/// captures GPS location, a coarse network-generation bucket, and
/// (best-effort) carrier name -- NOT serving-cell ID/PCI/TAC or
/// RSRP/RSRQ/RSSI/SINR, which Apple's CoreTelephony does not expose to
/// third-party apps without a carrier entitlement Apple grants directly to
/// the carrier (see the iOS SDK README's "Why this is scoped down" section).
///
/// `networkType` uses the SAME four-value vocabulary the backend already
/// validates against (`core/telemetry.py`'s `_NET_TYPES = {LTE, NR, UMTS,
/// GSM, UNKNOWN}`) so this device's samples land in the existing pipeline
/// unchanged -- no backend change needed to accept these. `connectionType`
/// and `carrierName` are EXTRA keys the current backend does not have a
/// column for; `core/telemetry.py`'s own docstring says as much ("any extra
/// keys in a sample are ignored") -- they are included here for the host
/// app's own local status/UI and so they're already in the wire format the
/// day someone decides to add `connection_type`/`carrier_name` columns
/// server-side. See the SDK README for that tradeoff spelled out.
struct Sample {
    let deviceId: String
    let timestampMs: Int64
    let lat: Double?
    let lon: Double?
    let gpsAccuracyM: Double?
    /// "LTE" | "NR" | "UMTS" | "GSM" | "UNKNOWN" -- matches the backend's
    /// `_NET_TYPES` exactly. "UNKNOWN" whenever the device is on Wi-Fi (no
    /// cellular RAT applies) or the RAT couldn't be read.
    let networkType: String
    /// "wifi" | "cellular" | "unknown" -- NOT currently stored server-side, see above.
    let connectionType: String
    /// Best-effort only -- see TelemetrySampleCollector.swift's doc comment
    /// on why this is frequently nil or a placeholder string on iOS 16+.
    /// NOT currently stored server-side, see above.
    let carrierName: String?
    let batteryPct: Int?
    /// "periodic" | "manual" -- deliberately only these two (no "handover"
    /// value; see TelemetryConfig.foregroundSampleIntervalSeconds for why
    /// iOS has no handover-triggered sampling to label). Both are already
    /// in the backend's `_TRIGGERS` set, so nothing new to accept there.
    let triggerReason: String

    /// Keys match `core/telemetry.py`'s `coerce_sample()` exactly for the
    /// fields that function has columns for. Absent keys read back as
    /// `None` there (e.g. `raw.get('cell_id')`), so simply omitting every
    /// RF-detail key this device has nothing to report -- rather than
    /// sending explicit JSON nulls -- is enough; no backend change needed.
    func toJSONObject() -> [String: Any] {
        var obj: [String: Any] = [
            "device_id": deviceId,
            "ts": timestampMs,
            "network_type": networkType,
            "trigger_reason": triggerReason,
            // Extra, currently-ignored-server-side keys -- see the type's
            // doc comment. Sent anyway: harmless today, free tomorrow.
            "connection_type": connectionType,
        ]
        if let lat { obj["lat"] = lat }
        if let lon { obj["lon"] = lon }
        if let gpsAccuracyM { obj["gps_accuracy_m"] = gpsAccuracyM }
        if let batteryPct { obj["battery_pct"] = batteryPct }
        if let carrierName { obj["carrier_name"] = carrierName }
        return obj
    }

    /// For round-tripping through the local JSONL queue file only (never
    /// sent to the server in this shape) -- see SampleQueue.swift.
    func toQueueLine() -> String {
        let obj = toJSONObject()
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    static func fromQueueLine(_ line: String) -> Sample? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let deviceId = obj["device_id"] as? String,
              let ts = obj["ts"] as? Int64 ?? (obj["ts"] as? NSNumber)?.int64Value,
              let networkType = obj["network_type"] as? String,
              let triggerReason = obj["trigger_reason"] as? String
        else { return nil }
        return Sample(
            deviceId: deviceId,
            timestampMs: ts,
            lat: obj["lat"] as? Double,
            lon: obj["lon"] as? Double,
            gpsAccuracyM: obj["gps_accuracy_m"] as? Double,
            networkType: networkType,
            connectionType: obj["connection_type"] as? String ?? "unknown",
            carrierName: obj["carrier_name"] as? String,
            batteryPct: obj["battery_pct"] as? Int ?? (obj["battery_pct"] as? NSNumber)?.intValue,
            triggerReason: triggerReason
        )
    }
}
