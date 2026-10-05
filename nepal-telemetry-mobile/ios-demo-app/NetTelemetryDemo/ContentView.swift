import CoreLocation
import NetTelemetry
import SwiftUI

/// Mirrors `MainActivity.kt`'s button set: Opt In / Opt Out / Sample Now /
/// Refresh Status / Upload Now / Drive-Test Consent / Rescue Enroll, each
/// calling straight through to the SDK's public API, same as the Android
/// demo does -- this view has no logic of its own beyond formatting
/// `TelemetryStatus` for display and two small confirmation dialogs
/// (drive-test consent, rescue enrollment) that are demo-app UI only, not
/// part of the SDK, exactly like the Android demo's two `AlertDialog`s.
struct ContentView: View {
    @StateObject private var locationDelegate = LocationPermissionRequester()
    @State private var statusText = "Opted in: false\nQueued samples: 0\nLast sample at: never"
    @State private var toastMessage: String?
    @State private var showDriveTestConsent = false
    @State private var driveTestMessage = "Loading..."
    @State private var showRescueEnroll = false
    @State private var rescueMsisdn = ""

    var body: some View {
        NavigationView {
            VStack(spacing: 16) {
                Text(statusText)
                    .font(.system(.body, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(8)

                if let toastMessage {
                    Text(toastMessage)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }

                Button("Opt In") { optIn() }
                    .buttonStyle(.borderedProminent)

                Button("Opt Out") {
                    NetTelemetry.optOut()
                    refreshStatus()
                }
                .buttonStyle(.bordered)

                Button("Sample Now") {
                    NetTelemetry.sampleNow()
                    toastMessage = "Sample requested -- refresh status in a moment"
                }
                .buttonStyle(.bordered)

                Button("Refresh Status") { refreshStatus() }
                    .buttonStyle(.bordered)

                Button("Upload Now") {
                    NetTelemetry.uploadNow()
                    toastMessage = "Upload requested -- check Console (subsystem np.nepaltelecom.telemetry) for the real result"
                }
                .buttonStyle(.bordered)

                Button("Drive-Test Consent") {
                    driveTestMessage = "Loading..."
                    showDriveTestConsent = true
                    NetTelemetry.fetchDriveTestConsentMessage { fetched in
                        driveTestMessage = fetched ?? "Would you like to take part in a network drive-test session? Your anonymized samples may be used for coverage analysis."
                    }
                }
                .buttonStyle(.bordered)

                Button("Rescue Enroll") {
                    rescueMsisdn = ""
                    showRescueEnroll = true
                }
                .buttonStyle(.bordered)

                Spacer()
            }
            .padding()
            .navigationTitle("NetTelemetry Demo")
        }
        .onAppear { refreshStatus() }
        .alert("Drive-Test Consent", isPresented: $showDriveTestConsent) {
            Button("Accept") {
                NetTelemetry.setDriveTestConsent(true)
                toastMessage = "Drive-test consent accepted"
            }
            Button("Decline", role: .cancel) {
                NetTelemetry.setDriveTestConsent(false)
                toastMessage = "Drive-test consent declined"
            }
        } message: {
            Text(driveTestMessage)
        }
        .alert("Rescue Location Registration", isPresented: $showRescueEnroll) {
            TextField("+977...", text: $rescueMsisdn)
                .keyboardType(.phonePad)
            Button("Register") {
                let msisdn = rescueMsisdn.trimmingCharacters(in: .whitespaces)
                if msisdn.isEmpty {
                    toastMessage = "Enter a phone number to register"
                } else {
                    NetTelemetry.enrollForRescue(msisdn: msisdn)
                    toastMessage = "Rescue location registration requested"
                }
            }
            Button("Withdraw", role: .destructive) {
                NetTelemetry.optOutOfRescue()
                toastMessage = "Rescue location withdrawal requested"
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            // "Register" is the only place in this whole demo app a raw
            // phone number is typed in, same note as the Android demo's
            // showRescueEnrollDialog() carries about core/rescue.py.
            Text("Register a phone number so a rescue operator can look up this device's last-known location in an emergency, or withdraw a previous registration.")
        }
    }

    private func optIn() {
        let status = CLLocationManager().authorizationStatus
        if status == .authorizedWhenInUse || status == .authorizedAlways {
            NetTelemetry.optIn()
            refreshStatus()
        } else {
            locationDelegate.requestPermission { granted in
                if granted {
                    NetTelemetry.optIn()
                    refreshStatus()
                } else {
                    toastMessage = "Location permission is required for telemetry sampling"
                }
            }
        }
    }

    private func refreshStatus() {
        let status = NetTelemetry.getStatus()
        let lastSample = status.lastSampleAtMs.map {
            DateFormatter.localizedString(
                from: Date(timeIntervalSince1970: Double($0) / 1000), dateStyle: .short, timeStyle: .medium
            )
        } ?? "never"
        statusText = """
        Opted in: \(status.optedIn)
        Queued samples: \(status.queuedSampleCount)
        Last sample at: \(lastSample)
        """
    }
}

/// Thin `CLLocationManagerDelegate` shim so the demo can ask for
/// when-in-use permission and get a callback -- demo-app plumbing only,
/// not part of the SDK (which never requests permission itself, same as
/// Android's SDK).
private final class LocationPermissionRequester: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var completion: ((Bool) -> Void)?

    func requestPermission(completion: @escaping (Bool) -> Void) {
        self.completion = completion
        manager.delegate = self
        manager.requestWhenInUseAuthorization()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        guard status != .notDetermined else { return }
        let granted = status == .authorizedWhenInUse || status == .authorizedAlways
        completion?(granted)
        completion = nil
    }
}

#Preview {
    ContentView()
}
