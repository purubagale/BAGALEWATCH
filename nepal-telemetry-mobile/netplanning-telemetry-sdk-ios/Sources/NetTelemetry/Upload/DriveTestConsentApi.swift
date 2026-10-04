import Foundation
import os.log

/// Talks to the backend's drive-test consent endpoints
/// (`POST .../drive-test-consent/`, `GET .../drive-test-consent-message/`,
/// `core/consent.py`) -- direct counterpart of Android's
/// `DriveTestConsentApi.kt`.
final class DriveTestConsentApi {
    private static let log = OSLog(subsystem: "np.nepaltelecom.telemetry", category: "DtConsent")

    private let apiKey: String?

    init(apiKey: String?) {
        self.apiKey = apiKey
    }

    /// completion receives true if the server accepted the request (2xx). Never throws.
    func setConsent(endpointUrl: URL, deviceId: String, consent: Bool, completion: @escaping (Bool) -> Void) {
        let obj: [String: Any] = ["device_id": deviceId, "consent": consent]
        guard let body = try? JSONSerialization.data(withJSONObject: obj) else {
            completion(false)
            return
        }
        var request = URLRequest(url: endpointUrl)
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        if let apiKey { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error {
                os_log("Drive-test consent request failed: %{public}@", log: Self.log, type: .info, String(describing: error))
                completion(false)
                return
            }
            let ok = (response as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
            completion(ok)
        }.resume()
    }

    /// GETs the current, superadmin-editable consent message. Returns nil
    /// on ANY failure (offline, non-2xx, unparseable body) rather than
    /// throwing -- a failed read has an obvious safe fallback (the host
    /// app shows its own hardcoded copy instead), same as Android.
    func fetchMessage(endpointUrl: URL, completion: @escaping (String?) -> Void) {
        var request = URLRequest(url: endpointUrl)
        request.httpMethod = "GET"
        if let apiKey { request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil,
                  let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let message = json["message"] as? String, !message.isEmpty
            else {
                completion(nil)
                return
            }
            completion(message)
        }.resume()
    }
}
