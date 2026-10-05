import Foundation

/// A plain append-only JSONL file as the local offline queue -- direct
/// counterpart of Android's `SampleQueue.kt`, same reasoning: at pilot
/// scale a flat file is enough and easy to inspect by hand, no need for a
/// Core Data/SQLite dependency.
///
/// Every public method is dispatched onto `queue` (a serial
/// `DispatchQueue`) -- the foreground timer, a BGTask, and a manual
/// `sampleNow()`/`uploadNow()` call can all touch this from different
/// contexts, mirroring Android's `ReentrantLock` usage here.
final class SampleQueue {
    static let maxQueuedSamples = 5_000

    private let fileURL: URL
    private let queue = DispatchQueue(label: "np.nepaltelecom.telemetry.samplequeue")
    private let defaults = UserDefaults.standard
    private static let lastSampleAtDefaultsKey = "np.nepaltelecom.telemetry.lastSampleAtMs"

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("netplanning_telemetry_queue.jsonl")
    }

    func append(_ sample: Sample) {
        queue.sync {
            let line = sample.toQueueLine() + "\n"
            if let handle = try? FileHandle(forWritingTo: fileURL) {
                handle.seekToEndOfFile()
                handle.write(Data(line.utf8))
                try? handle.close()
            } else {
                try? line.write(to: fileURL, atomically: true, encoding: .utf8)
            }
            defaults.set(sample.timestampMs, forKey: Self.lastSampleAtDefaultsKey)
            trimIfNeeded()
        }
    }

    /// When the most recent sample was taken, independent of whether it has
    /// uploaded/been removed from the queue yet -- same split from the
    /// queue file itself as Android's `statePrefs`.
    func lastSampleAtMs() -> Int64? {
        let value = defaults.object(forKey: Self.lastSampleAtDefaultsKey) as? Int64
        return value
    }

    func size() -> Int {
        queue.sync { readAllLines().count }
    }

    /// Returns up to `limit` queued samples, oldest first (FIFO upload order), without removing them.
    func peek(limit: Int) -> [Sample] {
        queue.sync { readAllLines().prefix(limit).compactMap { Sample.fromQueueLine($0) } }
    }

    /// Removes exactly the given samples (matched by device ID + timestamp,
    /// unique per sample together) after a confirmed successful upload.
    /// Anything not in `uploaded` stays queued, same as Android.
    func remove(_ uploaded: [Sample]) {
        guard !uploaded.isEmpty else { return }
        queue.sync {
            let uploadedKeys = Set(uploaded.map { "\($0.deviceId)|\($0.timestampMs)" })
            let remaining = readAllLines().filter { line in
                guard let s = Sample.fromQueueLine(line) else { return true } // keep anything unparseable
                return !uploadedKeys.contains("\(s.deviceId)|\(s.timestampMs)")
            }
            writeAllLines(remaining)
        }
    }

    func clear() {
        queue.sync { try? "".write(to: fileURL, atomically: true, encoding: .utf8) }
    }

    private func trimIfNeeded() {
        let lines = readAllLines()
        if lines.count > Self.maxQueuedSamples {
            writeAllLines(Array(lines.suffix(Self.maxQueuedSamples)))
        }
    }

    private func readAllLines() -> [String] {
        guard let contents = try? String(contentsOf: fileURL, encoding: .utf8) else { return [] }
        return contents.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private func writeAllLines(_ lines: [String]) {
        let text = lines.isEmpty ? "" : lines.joined(separator: "\n") + "\n"
        try? text.write(to: fileURL, atomically: true, encoding: .utf8)
    }
}
