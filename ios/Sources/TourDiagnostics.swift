import Foundation
import CoreLocation
import UIKit

/// Field diagnostics for the tour — a journal on the phone, never uploaded.
///
/// A missed trigger can't be debugged from a console: the phone is in a pocket,
/// and the moment is gone before it's noticed. This records the whole decision
/// chain — GPS fix → fetch → verdict → queue → playback — so a walk can be
/// replayed afterwards.
///
/// The journal stays on the device. It carries a GPS trace, and GrandTour's
/// promise is that a position never leaves the phone, so nothing here talks to
/// a server: an earlier version POSTed the journal to the selected server's
/// `/api/diag/logs` for the whole of every tour, static servers included, and
/// was removed for exactly that reason. Don't bring an uploader back. To read
/// a walk, pull `Library/Caches/tour-diag.jsonl` out of the app container
/// (Xcode → Devices and Simulators → Download Container; on the simulator
/// `xcrun simctl get_app_container booted fyi.grandtour.app data`) and run
/// `bun run diag <file>` in `server/`. One JSON event per line, newest last.
///
/// Design constraints that matter in the field:
///   - never block the tour: a failed write is dropped, not retried
///   - survive backgrounding: flush on resign-active, and write soon after
///     every event so a crash or kill loses seconds, not the walk
///   - stay bounded: the file keeps the newest `maxJournalEvents` (several
///     hours of fixes) and is trimmed when a tour starts
@MainActor
final class TourDiagnostics {
    static let shared = TourDiagnostics()

    /// Off by default; the tour turns it on so browsing doesn't fill the journal.
    var enabled = false

    private var buffer: [[String: Any]] = []
    private var flushTask: Task<Void, Never>?
    /// Pending short-fuse write after the latest event (see `log`).
    private var debounceTask: Task<Void, Never>?
    /// Correlates every event from one tour session.
    private var sessionId = UUID().uuidString.prefix(8).lowercased()

    /// The journal. Caches: not backed up, disposable, and iOS may purge it
    /// under storage pressure — this is a debugging aid, not a record.
    static let journalURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("tour-diag.jsonl")
    }()
    /// Keep the newest this many events across sessions; the tail of a long
    /// walk beats its middle.
    private static let maxJournalEvents = 20_000

    private init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { TourDiagnostics.shared.flush() }
        }
    }

    func startSession() {
        sessionId = UUID().uuidString.prefix(8).lowercased()
        enabled = true
        trimJournal()
        log("session_start", [
            "device": UIDevice.current.model,
            "os": UIDevice.current.systemVersion,
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            "audioRevision": "2026-09-07-focus-callbacks",
        ])
        startPeriodicFlush()
    }

    func endSession() {
        log("session_end", [:])
        flush()
        enabled = false
        flushTask?.cancel()
        flushTask = nil
        debounceTask?.cancel()
        debounceTask = nil
    }

    /// Record one event. Cheap and non-blocking.
    /// `auth_state` is allow-listed alongside `session_start`: it fires from
    /// the location callbacks before the tour enables diagnostics, and losing
    /// it is exactly how "did background updates engage?" became unanswerable.
    /// `audio_session_error` likewise: a failed activation at launch decides
    /// whether the first spot is audible.
    func log(_ event: String, _ fields: [String: Any] = [:]) {
        guard enabled || Self.alwaysLogged.contains(event) else { return }
        var e: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "session": String(sessionId),
            "event": event,
        ]
        e.merge(fields) { _, new in new }
        buffer.append(e)
        print("[diag] \(event) \(fields)")
        if buffer.count >= 40 {
            flush()
        } else {
            // A quiet moment after any event writes it, so a kill loses
            // seconds rather than the stretch since the last heartbeat.
            debounceTask?.cancel()
            debounceTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled else { return }
                self?.flush()
            }
        }
    }

    // Manual playback is also a useful parked CarPlay reproduction, even
    // before the tour's GPS-driven logging has been enabled.
    private static let alwaysLogged: Set<String> = [
        "session_start", "auth_state", "audio_session_error", "audio_focus",
        "audio_route_change", "audio_interruption", "audio_media_reset",
        "audio_playback_event", "audio_playback_state", "play_source",
        "keepalive_setting", "keepalive_start", "keepalive_stop", "remote_command",
    ]

    /// Convenience: one line capturing a location fix's full quality picture,
    /// since accuracy is the prime suspect for a missed trigger.
    func logFix(_ loc: CLLocation, extra: [String: Any] = [:]) {
        var f: [String: Any] = [
            "lat": loc.coordinate.latitude,
            "lng": loc.coordinate.longitude,
            "hAcc": loc.horizontalAccuracy,
            "speed": loc.speed,
            "course": loc.course,
            // A stale cached fix looks identical to a fresh one except here.
            "fixAgeS": Date().timeIntervalSince(loc.timestamp),
        ]
        f.merge(extra) { _, new in new }
        log("gps_fix", f)
    }

    private func startPeriodicFlush() {
        flushTask?.cancel()
        flushTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self else { return }
                self.flush()
            }
        }
    }

    /// Write what we have to the journal. Never throws into the caller.
    func flush() {
        debounceTask?.cancel()
        debounceTask = nil
        guard !buffer.isEmpty else { return }
        let batch = buffer
        buffer.removeAll()
        append(batch)
    }

    /// Append events to the journal, one JSON object per line — the shape
    /// `bun run diag` reads.
    private func append(_ batch: [[String: Any]]) {
        var data = Data()
        for e in batch {
            guard let line = try? JSONSerialization.data(withJSONObject: e) else { continue }
            data.append(line)
            data.append(0x0A)
        }
        guard !data.isEmpty else { return }
        let url = Self.journalURL
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Keep the journal bounded: drop the oldest lines past the cap.
    private func trimJournal() {
        let url = Self.journalURL
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        guard lines.count > Self.maxJournalEvents else { return }
        let kept = lines.suffix(Self.maxJournalEvents).joined(separator: "\n") + "\n"
        try? kept.write(to: url, atomically: true, encoding: .utf8)
    }
}
