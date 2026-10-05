import Foundation
import os.log

/// Deliberately plain `URLSession` rather than adding a third-party
/// networking dependency -- same reasoning as Android's `TelemetryApi.kt`
/// staying on `HttpURLConnection`: most host apps already carry their own
/// networking stack, this SDK shouldn't force a second one on them.
final class TelemetryApi {
    private static let log = OSLog(subsystem: "np.nepaltelecom.telemetry", category: "Upload")

    private let endpointUrl: URL
    private let apiKey: String?

    init(endpointUrl: URL, apiKey: String?) {
        self.endpointUrl = endpointUrl
        self.apiKey = apiKey
    }

    struct UploadResult {
        let accepted: Bool
        let remoteOptOutRequested: Bool
    }

    /// POSTs a JSON array of samples to `core/telemetry.py`'s
    /// `TelemetryIngestView` (`POST /api/telemetry/v1/samples/`). Never
    /// throws -- network/parse failures come back as
    /// `UploadResult(accepted: false, remoteOptOutRequested: false)`, same
    /// as Android.
    func uploadBatch(_ samples: [Sample], completion: @escaping (UploadResult) -> Void) {
        guard !samples.isEmpty else {
            completion(UploadResult(accepted: true, remoteOptOutRequested: false))
            return
        }
        let body: Data
        do {
            body = try JSONSerialization.data(withJSONObject: samples.map { $0.toJSONObject() })
        } catch {
            os_log("Failed to encode batch: %{public}@", log: Self.log, type: .error, String(describing: error))
            completion(UploadResult(accepted: false, remoteOptOutRequested: false))
            return
        }

        var request = URLRequest(url: endpointUrl)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        if let apiKey { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                os_log(
                    "Upload to %{public}@ failed: %{public}@",
                    log: Self.log, type: .info, self.endpointUrl.absoluteString, String(describing: error)
                )
                completion(UploadResult(accepted: false, remoteOptOutRequested: false))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(UploadResult(accepted: false, remoteOptOutRequested: false))
                return
            }
            let ok = (200...299).contains(http.statusCode)
            var remoteOptOut = false
            if ok, let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                // "opt_out" (mirrors Android's TelemetryApi.kt): the ONLY
                // channel the backend has to affect this device's local
                // opt-in state -- see core/telemetry.py's
                // TelemetryIngestView docstring. Missing/non-boolean is
                // just treated as false so an older backend never breaks
                // uploads.
                remoteOptOut = (json["opt_out"] as? Bool) ?? false
                os_log(
                    "Uploaded batch of %d sample(s) -- HTTP %d%{public}@",
                    log: Self.log, type: .debug, samples.count, http.statusCode,
                    remoteOptOut ? " (remote opt-out requested)" : ""
                )
            } else if !ok {
                let errorBody = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                os_log(
                    "Upload rejected by %{public}@ -- HTTP %d: %{public}@",
                    log: Self.log, type: .info, self.endpointUrl.absoluteString, http.statusCode, errorBody
                )
            }
            completion(UploadResult(accepted: ok, remoteOptOutRequested: remoteOptOut))
        }.resume()
    }
}
