import 'package:flutter/material.dart';
import 'package:ntc_telemetry/ntc_telemetry.dart';

/// A test screen for the ntc_telemetry plugin: every call behind a button,
/// the answer printed below. Not a design for the real app.
///
/// The server address comes from the build:
///   flutter run --dart-define=NTC_SERVER=https://dtwatch.ntc.net.np --dart-define=NTC_KEY=tel_...
const _server = String.fromEnvironment('NTC_SERVER', defaultValue: 'https://dtwatch.ntc.net.np');
const _key = String.fromEnvironment('NTC_KEY');

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MaterialApp(title: 'NTC telemetry test', home: TestScreen()));
}

class TestScreen extends StatefulWidget {
  const TestScreen({super.key});
  @override
  State<TestScreen> createState() => _TestScreenState();
}

class _TestScreenState extends State<TestScreen> {
  final _number = TextEditingController();
  final _code = TextEditingController();
  String _out = 'Not started.';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _run('Set up', () async {
      await NtcTelemetry.init(serverUrl: _server, apiKey: _key.isEmpty ? null : _key);
      final missing = await NtcTelemetry.missingPermissions();
      final reg = await NtcTelemetry.registration();
      return 'Ready. Missing permissions: ${missing.isEmpty ? 'none' : missing.join(', ')}\n'
          'Registered: ${reg.registered}${reg.number != null ? ' as ${reg.number}' : ''}, '
          'number verified: ${reg.numberVerified}';
    });
  }

  Future<void> _run(String label, Future<Object?> Function() action) async {
    setState(() {
      _busy = true;
      _out = '$label…';
    });
    String text;
    try {
      text = '$label: ${await action()}';
    } on NtcTelemetryException catch (e) {
      text = '$label failed: ${e.message}';
    }
    if (mounted) {
      setState(() {
        _busy = false;
        _out = text;
      });
    }
  }

  /// Waits for a call that returns nothing, then gives [message].
  Future<String> _then(Future<void> call, String message) async {
    await call;
    return message;
  }

  String _reading(SignalReading? r) => r == null
      ? 'no reading'
      : '${r.networkType} ${r.band ?? ''} level ${r.levelDbm ?? '-'} dBm, RSRQ ${r.rsrqDb ?? '-'}, '
          'PCI ${r.pci ?? '-'}, at ${r.lat?.toStringAsFixed(5) ?? '-'}, ${r.lon?.toStringAsFixed(5) ?? '-'}';

  String _speed(SpeedResult? s) => s == null
      ? 'that connection is not available'
      : s.error ?? 'down ${s.downloadMbps?.toStringAsFixed(1)} Mbps, up ${s.uploadMbps?.toStringAsFixed(1)} Mbps, '
          'ping ${s.pingMs?.toStringAsFixed(0)} ms, loss ${s.packetLossPct?.toStringAsFixed(0)}% over ${s.bearer}';

  @override
  Widget build(BuildContext context) {
    Widget button(String label, Future<Object?> Function() action) => Padding(
          padding: const EdgeInsets.only(right: 8, bottom: 8),
          child: FilledButton.tonal(onPressed: _busy ? null : () => _run(label, action), child: Text(label)),
        );
    return Scaffold(
      appBar: AppBar(title: const Text('NTC telemetry test')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text('Server: $_server', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 12),
        Text('Readings', style: Theme.of(context).textTheme.titleMedium),
        Wrap(children: [
          button('Read signal', () async => _reading(await NtcTelemetry.readSignal())),
          button('Cells', () async => (await NtcTelemetry.readCells())
              .map((c) => '${c.serving ? 'serving' : 'neighbour'} ${c.networkType} PCI ${c.pci} ${c.rsrpDbm} dBm')
              .join('\n')),
          button('Explain', () => NtcTelemetry.explainSignal()),
        ]),
        Text('Sharing', style: Theme.of(context).textTheme.titleMedium),
        Wrap(children: [
          button('Share 1 hour', () async => 'until ${await NtcTelemetry.startShare(minutes: 60)}'),
          button('Stop sharing', () => _then(NtcTelemetry.stopShare(), 'stopped')),
          button('Status', () => NtcTelemetry.status()),
          button('Send now', () => _then(NtcTelemetry.uploadNow(), 'queued for sending')),
        ]),
        Text('Drive test', style: Theme.of(context).textTheme.titleMedium),
        Wrap(children: [
          button('Start (shared)', () => _then(NtcTelemetry.startDriveTest(share: true), 'started')),
          button('Stop', () => _then(NtcTelemetry.stopDriveTest(), 'stopped')),
        ]),
        Text('Speed test', style: Theme.of(context).textTheme.titleMedium),
        Wrap(children: [
          button('Mobile data', () async => _speed(await NtcTelemetry.speedTest())),
          button('Wi-Fi', () async => _speed(await NtcTelemetry.speedTest(bearer: SpeedBearer.wifi))),
        ]),
        Text('Registration', style: Theme.of(context).textTheme.titleMedium),
        TextField(controller: _number, keyboardType: TextInputType.phone,
            decoration: const InputDecoration(labelText: 'Mobile number')),
        const SizedBox(height: 8),
        Wrap(children: [
          button('Register', () => NtcTelemetry.register(_number.text.trim())),
          button('Registration', () async {
            final r = await NtcTelemetry.refreshNumberStatus();
            return 'registered ${r.registered}, number ${r.number}, verified ${r.numberVerified}, '
                'needs code ${r.verificationNeeded}';
          }),
          button('Send code', () async => (await NtcTelemetry.sendNumberCode()) ? 'already verified' : 'code sent'),
        ]),
        TextField(controller: _code, keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Code from the SMS')),
        const SizedBox(height: 8),
        Wrap(children: [
          button('Confirm code', () async =>
              (await NtcTelemetry.confirmNumberCode(_code.text.trim())) ? 'verified' : 'not verified'),
          button('Report: slow data', () async {
            final o = await NtcTelemetry.reportProblem(category: 'slow_data', note: 'Test from the plugin example');
            if (o.sent) return 'sent.\n${o.hint}';
            if (o.notRegistered) return 'register this phone first';
            if (o.noLocation) return 'no position: switch location on';
            return o.error;
          }),
        ]),
        const Divider(),
        if (_busy) const LinearProgressIndicator(),
        SelectableText(_out),
      ]),
    );
  }
}
