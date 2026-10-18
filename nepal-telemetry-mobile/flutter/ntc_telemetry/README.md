# ntc_telemetry

A Flutter plugin that adds NTC network telemetry to a Flutter app on Android. It covers:

- signal readings shared with NTC
- drive tests
- speed tests over mobile data or Wi-Fi
- "Report a problem"
- registering the phone with its mobile number, including proof by SMS code

The plugin is a thin layer over NTC's Android telemetry SDK (`netplanning-telemetry-sdk`), which it carries in `android/sdk-repo`.

**Platforms.** Android only. iOS gives apps no signal or cell figures. On iOS every call throws `NtcTelemetryException('unsupported')`; check `NtcTelemetry.isSupported` first.

## Requirements

- **Installs on Android 7.0 (API 24) and newer; works on Android 8.0 (API 26) and newer.** The SDK reads cell signal with Android 8.0 APIs. On Android 7:
  - every feature call throws `NtcTelemetryException('unsupported')`;
  - `NtcTelemetry.supportedOnThisPhone()` returns false, so hide the telemetry screens;
  - nothing runs in the background.
- **Flutter 3.10 or newer** (Dart 3).
- **An NTC server address, and the shared ingest key until the phone is registered.** Puru supplies both.

## Add it

```yaml
dependencies:
  ntc_telemetry:
    path: ../ntc_telemetry   # or a git reference
```

You don't need to change any Gradle file. The plugin adds its own package folder to the app's build.

## Use it

```dart
import 'package:ntc_telemetry/ntc_telemetry.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (NtcTelemetry.isSupported) {
    await NtcTelemetry.init(serverUrl: 'https://dtwatch.ntc.net.np', apiKey: 'tel_...');
  }
  runApp(const MyApp());
}
```

`init` saves its settings on the phone. Android restarts the app in the background to take readings and send them, without running any Flutter code; the plugin then sets the SDK up again from those saved settings.

### Ask first, then share

Nothing is collected or sent until the app calls one of these:

- `NtcTelemetry.startShare(minutes: 60)`: shares for a set time, then stops by itself.
- `NtcTelemetry.optIn()`: shares until `optOut()`.

Before either:

1. Ask the user.
2. Ask for the permissions in `await NtcTelemetry.missingPermissions()`, for example with `permission_handler`.

| Permission | Why |
|---|---|
| Location (`ACCESS_FINE_LOCATION`) | Position of each reading; Android also requires it for cell information |
| Phone (`READ_PHONE_STATE`) | Some phones report cells only with it |
| Notifications (Android 13+) | The drive test shows a notification while it runs |

Background location is not used.

### Calls

| Call | What it does |
|---|---|
| `readSignal()`, `readCells()` | The current serving cell and its neighbours, for the screen; nothing is sent |
| `explainSignal()` | A plain explanation of the current reading (English) |
| `startShare` / `stopShare` / `optIn` / `optOut` / `status()` | Sharing with NTC |
| `startDriveTest(share:)` / `stopDriveTest()` | A drive with a reading every few seconds; shared or kept on the phone |
| `speedTest(bearer:)` | Download, upload, ping, jitter and loss. `mobile` uses mobile data even on Wi-Fi. While sharing is on, a finished test is sent to NTC |
| `register(msisdn)` | Registers the phone. If the first try fails, the SDK keeps trying in the background |
| `registration()` / `refreshNumberStatus()` | Registered, number, verified, and whether a code should be asked for |
| `sendNumberCode()` / `confirmNumberCode(code)` | Proof of the number by SMS code, when NTC's server can send SMS |
| `problemCategories()` / `reportProblem(category:, note:)` | One report with the reading and a speed test. Needs a registered phone |
| `setPushToken(token)` / `answerSampleRequest()` | Reading requests from NTC by push (see below) |

### Errors

A failed call throws `NtcTelemetryException`. Its `message` is always safe to show the user.

| `code` | Meaning |
|---|---|
| `not_initialized` | `init` was not called |
| `unsupported` | Android 7, or not Android |
| `api` | The server refused. `message` is its reason; `httpStatus` holds the status code |
| `failed` | Anything else |

### Push (optional)

NTC can ask phones that are sharing in an area for a fresh reading. To support it:

1. Pass the Firebase token to `setPushToken`, and again on each refresh.
2. When a data message with `type == "sample_request"` arrives, call `answerSampleRequest()`.

This needs NTC's Firebase project in the app.

## What the plugin adds to the app

- **Permissions:**
  - location
  - phone state
  - internet
  - network state, and changing the network (for the speed test over mobile data)
  - foreground service (drive test)
- **Components:**
  - a drive-test service
  - a share timer
  - WorkManager jobs that sample and upload
  - two start-up providers: one restores the saved settings, the other signs uploads once the phone is registered

## Example

`example/` is a test screen with every call behind a button:

```
cd example
flutter run --dart-define=NTC_SERVER=https://dtwatch.ntc.net.np --dart-define=NTC_KEY=tel_...
```

## Updating the SDK inside the plugin

From the Android project root (`nepal-telemetry-project`), run:

```
./gradlew :netplanning-telemetry-sdk:publish
```

This writes the SDK to `android/sdk-repo` here. Raise `sdkVersion` in the SDK's build file and `ntcSdkVersion` in `android/build.gradle.kts` together.
