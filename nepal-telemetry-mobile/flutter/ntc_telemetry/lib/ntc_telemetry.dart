/// NTC network telemetry for Flutter apps (Android).
///
/// Wraps Nepal Telecom's telemetry SDK: signal readings shared with NTC,
/// drive tests, speed tests, "report a problem", and registering the phone
/// with its number. Every call is a thin pass-through to the SDK; nothing is
/// collected or sent until the app calls [NtcTelemetry.optIn] or
/// [NtcTelemetry.startShare] after asking the user.
///
/// Platform errors arrive as [NtcTelemetryException]. Its [message] is
/// always safe to show the user.
library;

import 'dart:io' show Platform;

import 'package:flutter/services.dart';

const MethodChannel _channel = MethodChannel('np.nepaltelecom/ntc_telemetry');

/// A failed call. [code] is `not_initialized`, `api` (the server refused;
/// [httpStatus] holds its status) or `failed`.
class NtcTelemetryException implements Exception {
  NtcTelemetryException(this.code, this.message, [this.httpStatus]);
  final String code;
  final String message;
  final int? httpStatus;
  @override
  String toString() => 'NtcTelemetryException($code): $message';
}

/// One reading of the serving cell, with the phone's position when known.
/// Fields the network or phone did not report are null.
class SignalReading {
  SignalReading._(this.raw);
  final Map<String, dynamic> raw;

  DateTime get time => DateTime.fromMillisecondsSinceEpoch(raw['timestamp'] as int);
  double? get lat => (raw['lat'] as num?)?.toDouble();
  double? get lon => (raw['lon'] as num?)?.toDouble();
  double? get accuracyM => (raw['accuracyM'] as num?)?.toDouble();

  /// "LTE", "NR", "UMTS", "GSM" or "UNKNOWN".
  String get networkType => raw['networkType'] as String;

  /// e.g. "B3 (1800)", or "900" on 2G.
  String? get band => raw['band'] as String?;

  /// The level used for colouring: RSRP on 4G/5G, RSCP on 3G, RSSI on 2G.
  int? get levelDbm => raw['levelDbm'] as int?;
  int? get rsrpDbm => raw['rsrpDbm'] as int?;
  int? get rsrqDb => raw['rsrqDb'] as int?;
  int? get sinrDb => raw['sinrDb'] as int?;
  int? get cellId => raw['cellId'] as int?;
  int? get pci => raw['pci'] as int?;
}

/// One cell the modem reports (serving or neighbour).
class CellInfo {
  CellInfo._(this.raw);
  final Map<String, dynamic> raw;
  String get networkType => raw['networkType'] as String;
  bool get serving => raw['serving'] as bool;
  String? get band => raw['band'] as String?;
  int? get pci => raw['pci'] as int?;
  int? get cellId => raw['cellId'] as int?;
  int? get rsrpDbm => raw['rsrpDbm'] as int?;
  int? get rsrqDb => raw['rsrqDb'] as int?;
}

/// A speed test result. [error] is set, and the figures null, when it failed.
class SpeedResult {
  SpeedResult._(this.raw);
  final Map<String, dynamic> raw;
  double? get downloadMbps => (raw['downloadMbps'] as num?)?.toDouble();
  double? get uploadMbps => (raw['uploadMbps'] as num?)?.toDouble();
  double? get pingMs => (raw['pingMs'] as num?)?.toDouble();
  double? get jitterMs => (raw['jitterMs'] as num?)?.toDouble();
  double? get packetLossPct => (raw['packetLossPct'] as num?)?.toDouble();

  /// "mobile" or "wifi": the connection the test actually used.
  String? get bearer => raw['bearer'] as String?;
  String? get error => raw['error'] as String?;
}

/// What happened to a problem report.
class ProblemOutcome {
  ProblemOutcome._(this.raw);
  final Map<String, dynamic> raw;
  bool get sent => raw['sent'] as bool;
  bool get notRegistered => raw['notRegistered'] as bool;
  bool get noLocation => raw['noLocation'] as bool;

  /// Safe to show when not [sent].
  String? get error => raw['error'] as String?;

  /// A plain explanation of the reading for the user (English).
  String? get hint => raw['hint'] as String?;
  SignalReading? get reading =>
      raw['reading'] == null ? null : SignalReading._(Map<String, dynamic>.from(raw['reading'] as Map));
  SpeedResult? get speed =>
      raw['speed'] == null ? null : SpeedResult._(Map<String, dynamic>.from(raw['speed'] as Map));
}

/// This phone's registration with NTC.
class Registration {
  Registration._(this.raw);
  final Map<String, dynamic> raw;
  bool get registered => raw['registered'] as bool;
  String? get number => raw['number'] as String?;
  bool get numberVerified => raw['numberVerified'] as bool;

  /// True when NTC can text a code and the number is not proved yet: ask for it.
  bool get verificationNeeded => raw['verificationNeeded'] as bool;
}

enum SpeedBearer { mobile, wifi }

class NtcTelemetry {
  NtcTelemetry._();

  static Future<T?> _call<T>(String method, [Map<String, Object?>? args]) async {
    try {
      return await _channel.invokeMethod<T>(method, args);
    } on PlatformException catch (e) {
      throw NtcTelemetryException(e.code, e.message ?? 'Something went wrong.', e.details as int?);
    } on MissingPluginException {
      throw NtcTelemetryException('unsupported', 'Not available on this platform.');
    }
  }

  static Map<String, dynamic> _map(Object? v) => Map<String, dynamic>.from(v as Map);

  /// True on Android, the only platform with the SDK.
  static bool get isSupported => Platform.isAndroid;

  /// Sets the SDK up. Call once at app start, before any other call. The
  /// settings are kept, so background work after a restart uses them too.
  ///
  /// [serverUrl] is e.g. `https://dtwatch.ntc.net.np`. [apiKey] is the
  /// shared ingest key used until the phone is registered.
  static Future<void> init({
    required String serverUrl,
    String? apiKey,
    bool uploadOnlyOnWifi = true,
    int samplingIntervalMinutes = 15,
    int uploadIntervalMinutes = 30,
    bool calls = true,
    bool rescue = true,
  }) =>
      _call('init', {
        'serverUrl': serverUrl,
        'apiKey': apiKey,
        'uploadOnlyOnWifi': uploadOnlyOnWifi,
        'samplingIntervalMinutes': samplingIntervalMinutes,
        'uploadIntervalMinutes': uploadIntervalMinutes,
        'calls': calls,
        'rescue': rescue,
      });

  /// What this platform supports, e.g. `{'signal': true, 'driveTest': true}`.
  static Future<Map<String, dynamic>> capabilities() async => _map(await _call('capabilities'));

  /// True when this phone can use the features: Android 8.0 or newer. On
  /// Android 7 the plugin installs but every feature call throws
  /// [NtcTelemetryException] with code `unsupported`; hide the screens.
  static Future<bool> supportedOnThisPhone() async {
    if (!isSupported) return false;
    return (await capabilities())['supported'] == true;
  }

  /// Android permissions the readings need and the app has not been granted
  /// yet. Ask for them (e.g. with permission_handler) before sharing.
  static Future<List<String>> missingPermissions() async =>
      List<String>.from(await _call<List<Object?>>('missingPermissions') ?? const []);

  // ---- Sharing with NTC ----

  /// Shares readings in the background until [optOut].
  static Future<void> optIn() => _call('optIn');
  static Future<void> optOut({bool wipeQueued = true}) => _call('optOut', {'wipeQueued': wipeQueued});
  static Future<bool> isOptedIn() async => await _call<bool>('isOptedIn') ?? false;

  /// Shares for [minutes] only, then stops by itself. Returns the end time.
  static Future<DateTime> startShare({int minutes = 60}) async =>
      DateTime.fromMillisecondsSinceEpoch(await _call<int>('startShare', {'minutes': minutes}) ?? 0);
  static Future<void> stopShare() => _call('stopShare');
  static Future<DateTime?> shareExpiresAt() async {
    final ms = await _call<int>('shareExpiresAt');
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  static Future<Map<String, dynamic>> status() async => _map(await _call('status'));
  static Future<void> sampleNow() => _call('sampleNow');
  static Future<void> uploadNow() => _call('uploadNow');

  // ---- Readings on screen (nothing is sent) ----

  static Future<SignalReading?> readSignal() async {
    final v = await _call<Map<Object?, Object?>>('readLiveSample');
    return v == null ? null : SignalReading._(_map(v));
  }

  static Future<List<CellInfo>> readCells() async {
    final v = await _call<List<Object?>>('readCells') ?? const [];
    return v.map((c) => CellInfo._(_map(c))).toList();
  }

  /// A plain explanation of the current reading (English), sending nothing.
  static Future<String?> explainSignal() => _call<String>('explain');

  // ---- Drive test ----

  /// Records a route with a reading every few seconds. With [share] the
  /// drive is sent to NTC; without, it stays on the phone.
  static Future<void> startDriveTest({required bool share}) => _call('startDriveTest', {'share': share});
  static Future<void> stopDriveTest() => _call('stopDriveTest');
  static Future<String?> currentDriveSessionId() => _call<String>('currentDriveSessionId');

  // ---- Push: reading requests from NTC ----

  /// Pass the Firebase token (and each refresh of it).
  static Future<void> setPushToken(String? token) => _call('setPushToken', {'token': token});

  /// Call when a push with `type == "sample_request"` arrives.
  static Future<void> answerSampleRequest() => _call('answerSampleRequest');

  // ---- Registration and the number ----

  /// Registers this phone with [msisdn]. If the first try fails, the SDK
  /// keeps trying in the background (`retrying` in the answer).
  static Future<Map<String, dynamic>> register(String msisdn, {bool employee = false}) async =>
      _map(await _call('register', {'msisdn': msisdn, 'userType': employee ? 'employee' : 'general'}));

  static Future<Registration> registration() async => Registration._(_map(await _call('registration')));
  static Future<Registration> refreshNumberStatus() async =>
      Registration._(_map(await _call('refreshNumberStatus')));

  /// Asks NTC to text a code to the registered number. True if already verified.
  static Future<bool> sendNumberCode() async => await _call<bool>('sendNumberCode') ?? false;

  /// Sends the 6-digit code back. Throws with the server's reason when wrong.
  static Future<bool> confirmNumberCode(String code) async =>
      await _call<bool>('confirmNumberCode', {'code': code}) ?? false;

  // ---- Speed test and problem report ----

  /// Runs a speed test. [SpeedBearer.mobile] uses mobile data even while on
  /// Wi-Fi; with [fallback] it uses the current connection when mobile data
  /// is off. Returns null when that connection is not available. A finished
  /// test is sent to NTC while sharing is on, unless [report] is false.
  static Future<SpeedResult?> speedTest({
    SpeedBearer bearer = SpeedBearer.mobile,
    bool fallback = false,
    bool report = true,
  }) async {
    final v = await _call<Map<Object?, Object?>>(
        'speedTest', {'bearer': bearer.name, 'fallback': fallback, 'report': report});
    return v == null ? null : SpeedResult._(_map(v));
  }

  /// The categories a report can have: `[{code, label}]`.
  static Future<List<Map<String, String>>> problemCategories() async {
    final v = await _call<List<Object?>>('problemCategories') ?? const [];
    return v.map((c) => Map<String, String>.from(c as Map)).toList();
  }

  /// Reads the signal, runs a speed test and sends one report to NTC.
  /// Needs a registered phone. Takes up to about a minute.
  static Future<ProblemOutcome> reportProblem({
    required String category,
    String note = '',
    bool withSpeedTest = true,
  }) async =>
      ProblemOutcome._(_map(await _call('reportProblem',
          {'category': category, 'note': note, 'withSpeedTest': withSpeedTest})));

  /// This phone's SDK device id (pseudonymous).
  static Future<String?> sdkDeviceId() => _call<String>('sdkDeviceId');
}
