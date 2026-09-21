import HealthKit

/// Keeps the app running with the wrist down. A tour is a workout-shaped
/// activity (continuous GPS, hours long, outdoors), and an HKWorkoutSession
/// is the platform's sanctioned way to hold background runtime and location
/// delivery for one — audio background mode alone would suspend us between
/// spots and miss triggers.
///
/// Deliberately writes nothing to Health: the session is ended and the
/// builder's data discarded, never finished into a workout sample.
@MainActor
final class WorkoutKeeper: NSObject, ObservableObject {
    @Published private(set) var isRunning = false

    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?

    /// One-time HealthKit prompt. Starting a session requires share
    /// authorization for the workout type even though we never save one.
    func requestAuthorization() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable() else { return false }
        return await withCheckedContinuation { cont in
            store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: []) { ok, error in
                if let error {
                    print("WorkoutKeeper: authorization failed: \(error)")
                }
                cont.resume(returning: ok)
            }
        }
    }

    func start(activity: HKWorkoutActivityType = .walking) {
        guard session == nil else { return }
        let config = HKWorkoutConfiguration()
        config.activityType = activity
        config.locationType = .outdoor
        do {
            let s = try HKWorkoutSession(healthStore: store, configuration: config)
            let b = s.associatedWorkoutBuilder()
            b.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: config)
            s.delegate = self
            session = s
            builder = b
            s.startActivity(with: Date())
            b.beginCollection(withStart: Date()) { _, error in
                if let error {
                    print("WorkoutKeeper: beginCollection failed: \(error)")
                }
            }
            isRunning = true
        } catch {
            print("WorkoutKeeper: start failed: \(error)")
            session = nil
            builder = nil
        }
    }

    func stop() {
        guard let s = session else { return }
        s.end()
        builder?.endCollection(withEnd: Date()) { [weak self] _, _ in
            // Discard, never finishWorkout: no sample lands in Health.
            self?.builder?.discardWorkout()
            Task { @MainActor [weak self] in
                self?.builder = nil
            }
        }
        session = nil
        isRunning = false
    }
}

extension WorkoutKeeper: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        Task { @MainActor [weak self] in
            if toState == .ended || toState == .stopped {
                self?.isRunning = false
            }
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        print("WorkoutKeeper: session failed: \(error)")
        Task { @MainActor [weak self] in
            self?.isRunning = false
            self?.session = nil
            self?.builder = nil
        }
    }
}
