import Foundation
import Security

/// The pilot's one hard privacy rule, enforced in code exactly like
/// Android's `DeviceIdentity.kt`: a locally generated UUID with no
/// relationship to the device's IMEI/UDID/serial or the subscriber's
/// MSISDN. This module has no API that would let a caller substitute one
/// of those in its place.
///
/// PLATFORM DIFFERENCE FROM ANDROID, worth reading before relying on this:
/// Android's SharedPreferences (and this SDK's EncryptedSharedPreferences)
/// are wiped automatically when the app is uninstalled -- a fresh install
/// on the same phone gets a brand-new pseudonymous ID for free. iOS's
/// Keychain is NOT wiped on uninstall by default; a Keychain item written
/// by an app can still be read back by a later reinstall of that same app
/// (this is a well-known, deliberate iOS behaviour, not a bug). Left
/// unhandled, that would mean "uninstall and reinstall" quietly does NOT
/// give a subscriber a fresh pseudonymous identity the way it does on
/// Android, which is a real, subtle break of a privacy property this
/// pilot cares about (see the SDK-wide privacy section in the Android
/// README, which this module inherits).
///
/// Fixed with the standard idiom for this exact problem: `hasLaunchedBefore`
/// is stored in UserDefaults, which (unlike Keychain) genuinely IS wiped on
/// uninstall. If Keychain already holds a device ID but UserDefaults has
/// never seen this app before, that combination can only mean "this is a
/// reinstall onto a device that still has a stale Keychain item from
/// before" -- so that stale ID (and the opted-in flag alongside it) is
/// deleted and a fresh one generated, before anything reads `deviceId`.
final class DeviceIdentity {
    private static let service = "np.nepaltelecom.telemetry.identity"
    private static let deviceIdAccount = "pseudonymous_device_id"
    private static let optedInAccount = "opted_in"
    private static let hasExplicitOptInAccount = "has_explicit_opt_in"
    private static let hasLaunchedBeforeDefaultsKey = "np.nepaltelecom.telemetry.hasLaunchedBefore"

    init() {
        reconcileReinstall()
    }

    private func reconcileReinstall() {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: Self.hasLaunchedBeforeDefaultsKey) { return }
        // First launch UserDefaults has ever seen for this app on this
        // install. Any Keychain item found now predates this install --
        // wipe it before it's ever read, so a fresh pseudonymous ID (and a
        // fresh "no explicit opt-in yet" state, so TelemetryConfig.defaultOptIn
        // gets to seed correctly again too) is what this install actually gets.
        Self.deleteKeychainItem(account: Self.deviceIdAccount)
        Self.deleteKeychainItem(account: Self.optedInAccount)
        Self.deleteKeychainItem(account: Self.hasExplicitOptInAccount)
        defaults.set(true, forKey: Self.hasLaunchedBeforeDefaultsKey)
    }

    var deviceId: String {
        if let existing = Self.readKeychainString(account: Self.deviceIdAccount) {
            return existing
        }
        let fresh = UUID().uuidString
        Self.writeKeychainString(fresh, account: Self.deviceIdAccount)
        return fresh
    }

    var optedIn: Bool {
        get { Self.readKeychainString(account: Self.optedInAccount) == "1" }
        set {
            Self.writeKeychainString(newValue ? "1" : "0", account: Self.optedInAccount)
            Self.writeKeychainString("1", account: Self.hasExplicitOptInAccount)
        }
    }

    /// Whether this device has ANY stored opt-in choice yet -- same purpose
    /// as Android's field of the same name: lets `NetTelemetry.initialize`
    /// seed `TelemetryConfig.defaultOptIn` exactly once, without ever
    /// overwriting a choice the subscriber (or a prior `initialize` call on
    /// this install) already made. Deliberately keyed separately from
    /// `optedIn` itself for the same reason as Android: reading `optedIn`
    /// alone can't tell "explicitly opted out" apart from "never asked."
    var hasExplicitOptInState: Bool {
        Self.readKeychainString(account: Self.hasExplicitOptInAccount) == "1"
    }

    // MARK: - Keychain plumbing

    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable by
    /// background tasks (device need not be freshly unlocked, unlike
    /// `WhenUnlocked`), but `ThisDeviceOnly` opts out of iCloud Keychain
    /// sync -- this pseudonymous ID should stay local to one physical
    /// device, not silently propagate to a subscriber's other iPhones via
    /// their iCloud account.
    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func readKeychainString(account: String) -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func writeKeychainString(_ value: String, account: String) {
        let data = Data(value.utf8)
        let existingQuery = baseQuery(account: account)
        let attributesToUpdate: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(existingQuery as CFDictionary, attributesToUpdate as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var addQuery = baseQuery(account: account)
            addQuery[kSecValueData as String] = data
            addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(addQuery as CFDictionary, nil)
        }
    }

    private static func deleteKeychainItem(account: String) {
        SecItemDelete(baseQuery(account: account) as CFDictionary)
    }
}
