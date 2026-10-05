import Foundation
import os.log

/// Talks to the backend's rescue-consent endpoint (`POST .../rescue-enroll/`,
/// `core/rescue.py`'s `RescueEnrollView`) -- direct counterpart of
/// Android's `RescueApi.kt`, same plain-`URLSession`/Bearer-token approach
/// and same JSON body shape (`device_id`, `consent`, `msisdn`).
final class RescueApi {
    private static let log = OSLog(subsystem: "np.nepaltelecom.telemetry", category: "Rescue")

    private let endpointUrl: URL
    private let apiKey: String?

    init(endpointUrl: URL, apiKey: String?) {
        self.endpointUrl = endpointUrl
        self.apiKey = apiKey
    }

    /// completion receives true if the server accepted the request (2xx). Never throws.
    func enroll(deviceId: String, consent: Bool, msisdn: String?, completion: @escaping (Bool) -> Void) {
        var obj: [String: Any] = ["device_id": deviceId, "consent": consent]
        if let msisdn { obj["msisdn"] = msisdn }
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
                os_log("Rescue enrollment request failed: %{public}@", log: Self.log, type: .info, String(describing: error))
                completion(false)
                return
            }
            let ok = (response as? HTTPURLResponse).map { (200...299).contains($0.statusCode) } ?? false
            if !ok {
                os_log("Rescue enrollment rejected by %{public}@", log: Self.log, type: .info, self.endpointUrl.absoluteString)
            }
            completion(ok)
        }.resume()
    }
}
