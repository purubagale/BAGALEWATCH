import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ntc_telemetry/ntc_telemetry.dart';

/// Checks the Dart side against a stand-in for the Android side: method
/// names, arguments, how answers are read, and how errors arrive.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('np.nepaltelecom/ntc_telemetry');
  final calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      switch (call.method) {
        case 'init':
          return null;
        case 'readLiveSample':
          return {
            'timestamp': 1760600000000,
            'lat': 27.7,
            'lon': 85.3,
            'networkType': 'LTE',
            'band': 'B3 (1800)',
            'levelDbm': -95,
            'rsrqDb': -11,
            'pci': 12,
          };
        case 'speedTest':
          return {'downloadMbps': 12.5, 'uploadMbps': 4, 'pingMs': 30.0, 'bearer': 'mobile', 'error': null};
        case 'registration':
          return {'registered': true, 'number': '9779800000000', 'numberVerified': false, 'verificationNeeded': true};
        case 'reportProblem':
          return {'sent': false, 'notRegistered': true, 'noLocation': false, 'error': null, 'hint': null};
        case 'confirmNumberCode':
          throw PlatformException(code: 'api', message: 'The code is wrong.', details: 400);
        case 'missingPermissions':
          return ['android.permission.ACCESS_FINE_LOCATION'];
      }
      return null;
    });
  });

  test('init sends the server and settings', () async {
    await NtcTelemetry.init(serverUrl: 'https://dtwatch.ntc.net.np', apiKey: 'tel_x');
    expect(calls.single.method, 'init');
    expect(calls.single.arguments['serverUrl'], 'https://dtwatch.ntc.net.np');
    expect(calls.single.arguments['uploadOnlyOnWifi'], true);
  });

  test('a reading is read with its fields', () async {
    final r = await NtcTelemetry.readSignal();
    expect(r!.networkType, 'LTE');
    expect(r.band, 'B3 (1800)');
    expect(r.levelDbm, -95);
    expect(r.lat, 27.7);
    expect(r.sinrDb, isNull);
  });

  test('speed test passes the connection and reads numbers of either kind', () async {
    final s = await NtcTelemetry.speedTest(bearer: SpeedBearer.wifi);
    expect(calls.single.arguments['bearer'], 'wifi');
    expect(s!.uploadMbps, 4.0);
    expect(s.bearer, 'mobile');
  });

  test('registration and problem outcome', () async {
    final reg = await NtcTelemetry.registration();
    expect(reg.registered, isTrue);
    expect(reg.verificationNeeded, isTrue);
    final o = await NtcTelemetry.reportProblem(category: 'slow_data');
    expect(o.sent, isFalse);
    expect(o.notRegistered, isTrue);
    expect(calls.last.arguments['withSpeedTest'], isTrue);
  });

  test('a server refusal arrives as NtcTelemetryException with its reason', () async {
    expect(
      () => NtcTelemetry.confirmNumberCode('123456'),
      throwsA(isA<NtcTelemetryException>()
          .having((e) => e.code, 'code', 'api')
          .having((e) => e.message, 'message', 'The code is wrong.')
          .having((e) => e.httpStatus, 'httpStatus', 400)),
    );
  });

  test('missing permissions come back as a list', () async {
    expect(await NtcTelemetry.missingPermissions(), ['android.permission.ACCESS_FINE_LOCATION']);
  });
}
