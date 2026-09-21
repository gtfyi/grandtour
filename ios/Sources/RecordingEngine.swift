import AVFoundation
import Combine
import QuartzCore

/// Owns the microphone for walk-and-record mode: one voice take at a time,
/// AAC into an .m4a under Documents/recordings (files survive app restarts —
/// a take with no signal must not be lost), with live metering for the UI
/// and a local preview player so the creator can check a take before it
/// publishes.
///
/// Capture runs through AVAudioEngine's input tap, NOT AVAudioRecorder:
/// the recorder's AudioQueue start deadlocked inside CoreAudio on the
/// iOS 26 simulator (AQServer queue vs the UISound renderer's device lock,
/// sample-verified), while the engine's AURemoteIO path — the same family
/// the rest of the app plays through — starts cleanly. AVAudioFile converts
/// the tap's PCM buffers to AAC on write.
///
/// Completely separate from tour playback: `AudioPlayer` never sees these
/// files, and the audio session swap (`AudioSession.beginRecordSession`)
/// happens only while the recorder or preview is actually running.
@MainActor
final class RecordingEngine: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsed: TimeInterval = 0
    /// Microphone level, 0…1, for the record button's pulse.
    @Published private(set) var level: Double = 0
    @Published private(set) var isPreviewing = false

    private var engine: AVAudioEngine?
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var framesWritten: AVAudioFramePosition = 0
    private var fileSampleRate: Double = 44_100
    private var previewPlayer: AVAudioPlayer?
    private var uiTimer: Timer?
    /// Written from the audio render thread, read by the UI timer.
    private let meter = MeterBox()

    /// Where takes live until their upload succeeds.
    static var recordingsDir: URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// iOS 17+ microphone permission. False = denied; the UI points at Settings.
    ///
    /// Deliberately NOT the SDK's async overload: its continuation resumed on
    /// CoreAudio's private AQServer queue (iOS 26 simulator, field-observed),
    /// so the "MainActor" caller kept running there and the next CoreAudio
    /// call dispatch_sync'd onto that same queue — a self-deadlock that froze
    /// the whole app. Resume explicitly on main.
    nonisolated static func requestPermission() async -> Bool {
        if AVAudioApplication.shared.recordPermission == .granted { return true }
        return await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { cont.resume(returning: granted) }
            }
        }
    }

    /// Begin a take. Returns the file it is recording into, or nil when the
    /// session or engine could not start (already logged).
    func start() -> URL? {
        guard !isRecording else { return fileURL }
        guard AudioSession.beginRecordSession() else { return nil }
        let url = Self.recordingsDir.appendingPathComponent("take-\(UUID().uuidString).m4a")
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            TourDiagnostics.shared.log("record_start_failed", ["reason": "no input format"])
            AudioSession.endRecordSession()
            return nil
        }
        do {
            // AAC in an .m4a container; AVAudioFile converts from the tap's
            // PCM processing format on each write. Keep the hardware channel
            // count — a mismatch throws at write time, not here.
            let file = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: format.channelCount,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ])
            let meter = self.meter
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
                // Render thread: write + meter only, no allocation-heavy work.
                do {
                    try file.write(from: buffer)
                    meter.add(frames: AVAudioFramePosition(buffer.frameLength))
                } catch {
                    meter.noteWriteError()
                }
                meter.update(rms: Self.rms(of: buffer))
            }
            engine.prepare()
            try engine.start()
            self.engine = engine
            self.file = file
            fileURL = url
            framesWritten = 0
            fileSampleRate = format.sampleRate
            meter.reset()
            isRecording = true
            elapsed = 0
            startUITimer()
            TourDiagnostics.shared.log("record_start", [
                "file": url.lastPathComponent,
                "sampleRate": format.sampleRate,
                "channels": format.channelCount,
            ])
            return url
        } catch {
            input.removeTap(onBus: 0)
            TourDiagnostics.shared.log("record_start_failed", ["error": error.localizedDescription])
            AudioSession.endRecordSession()
            return nil
        }
    }

    /// End the take. The audio session stays in record mode so the preview
    /// can play; call `finish()` when the take is saved or discarded.
    /// Returns nil for a take too short to mean anything.
    func stop() -> (fileURL: URL, durationMs: Double)? {
        guard let engine, let url = fileURL else { return nil }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        file = nil // closes the file, finalizing the m4a
        fileURL = nil
        isRecording = false
        stopUITimer()
        let frames = meter.framesWritten
        let duration = fileSampleRate > 0 ? Double(frames) / fileSampleRate : 0
        TourDiagnostics.shared.log("record_stop", [
            "seconds": duration, "writeErrors": meter.writeErrors,
        ])
        guard duration >= 0.5 else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return (url, duration * 1_000)
    }

    /// Listen back to a finished take (toggles).
    func togglePreview(of url: URL) {
        if isPreviewing {
            previewPlayer?.stop()
            previewPlayer = nil
            isPreviewing = false
            return
        }
        do {
            let player = try AVAudioPlayer(contentsOf: url)
            player.delegate = self
            player.play()
            previewPlayer = player
            isPreviewing = true
        } catch {
            TourDiagnostics.shared.log("record_preview_failed", ["error": error.localizedDescription])
        }
    }

    /// Done with the microphone entirely (take saved, queued, or discarded):
    /// stop everything and hand the audio session back to playback.
    func finish() {
        if isRecording { _ = stop() }
        previewPlayer?.stop()
        previewPlayer = nil
        isPreviewing = false
        AudioSession.endRecordSession()
    }

    // MARK: UI updates (main thread, fed by the render-thread meter box)

    private func startUITimer() {
        uiTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func stopUITimer() {
        uiTimer?.invalidate()
        uiTimer = nil
        level = 0
    }

    private func tick() {
        guard isRecording else { return }
        elapsed = fileSampleRate > 0 ? Double(meter.framesWritten) / fileSampleRate : 0
        // RMS ≈ 0…1; speech peaks near 0.3. Map to a 0…1 pulse.
        level = min(1, meter.currentRMS * 4)
    }

    private nonisolated static func rms(of buffer: AVAudioPCMBuffer) -> Double {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
        return Double(sqrt(sum / Float(buffer.frameLength)))
    }

    // MARK: Delegates

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.previewPlayer = nil
            self.isPreviewing = false
        }
    }
}

/// Lock-guarded scratch state shared between the audio render thread (writes)
/// and the main-thread UI timer (reads). NSLock is safe on a render thread at
/// this contention level (two parties, sub-microsecond holds).
private final class MeterBox: @unchecked Sendable {
    private let lock = NSLock()
    private var rms: Double = 0
    private var frames: AVAudioFramePosition = 0
    private var errors = 0

    func reset() {
        lock.lock(); defer { lock.unlock() }
        rms = 0; frames = 0; errors = 0
    }

    func update(rms value: Double) {
        lock.lock(); defer { lock.unlock() }
        rms = value
    }

    func add(frames count: AVAudioFramePosition) {
        lock.lock(); defer { lock.unlock() }
        frames += count
    }

    func noteWriteError() {
        lock.lock(); defer { lock.unlock() }
        errors += 1
    }

    var currentRMS: Double {
        lock.lock(); defer { lock.unlock() }
        return rms
    }

    var framesWritten: AVAudioFramePosition {
        lock.lock(); defer { lock.unlock() }
        return frames
    }

    var writeErrors: Int {
        lock.lock(); defer { lock.unlock() }
        return errors
    }
}
