import UIKit
import CarPlay

/// Which CarPlay experience this build presents. Decided at build time
/// (GRANDTOUR_CARPLAY_MODE in project.yml → Info.plist GrandTourCarPlayMode)
/// because the two need different Apple-granted entitlements, and starting
/// a template the entitlement doesn't cover throws at runtime:
///   - `audio` (com.apple.developer.carplay-audio): lists + the system Now
///     Playing screen (CarPlayAudioController). The realistic grant for an
///     audio tour app, and the default.
///   - `navigation` (com.apple.developer.carplay-maps): the live map and
///     turn-by-turn directions (CarPlayController).
enum CarPlayMode: String {
    case audio
    case navigation
    case none

    static var configured: CarPlayMode {
        let raw = Bundle.main.object(forInfoDictionaryKey: "GrandTourCarPlayMode") as? String
        return CarPlayMode(rawValue: raw?.lowercased() ?? "") ?? .none
    }
}

/// Entry point for the CarPlay scene, named in project.yml's scene manifest.
/// Templates only appear when the build carries a CarPlay entitlement —
/// in both the app signature and its provisioning profile; see project.yml.
/// Now Playing / steering-wheel controls need no entitlement
/// and are wired regardless (NowPlayingController).
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var audioController: CarPlayAudioController?
    private var navigationController: CarPlayController?

    // Navigation-entitled apps are handed a CPWindow; audio apps are not.
    // Never fall back across categories: navigation permission doesn't grant
    // permission to present audio-only templates such as Now Playing.
    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController,
        to window: CPWindow
    ) {
        connect(interfaceController: interfaceController, window: window)
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        connect(interfaceController: interfaceController, window: nil)
    }

    private func connect(interfaceController: CPInterfaceController, window: CPWindow?) {
        guard audioController == nil, navigationController == nil else { return }
        AppServices.shared.bootstrap()
        // GrandTour owns the car's media session for the whole run. Reassert
        // that claim when CarPlay connects, including the gaps between stories.
        // takeOver() preserves the Bluetooth media configuration and doesn't
        // restart or unpause narration. System interruptions retain priority.
        AudioSession.takeOver()
        let mode = CarPlayMode.configured
        TourDiagnostics.shared.log("carplay_connect", [
            "mode": mode.rawValue, "hasWindow": window != nil,
        ])
        switch mode {
        case .navigation:
            guard let window else {
                TourDiagnostics.shared.log("carplay_configuration_error", ["reason": "navigation_window_missing"])
                return
            }
            let controller = CarPlayController(interfaceController: interfaceController, window: window)
            navigationController = controller
            controller.start()
        case .audio:
            let controller = CarPlayAudioController(interfaceController: interfaceController)
            audioController = controller
            controller.start()
        case .none:
            TourDiagnostics.shared.log("carplay_configuration_error", ["reason": "carplay_disabled_or_invalid_mode"])
        }
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnect interfaceController: CPInterfaceController,
        from window: CPWindow
    ) {
        disconnect()
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        disconnect()
    }

    private func disconnect() {
        TourDiagnostics.shared.log("carplay_disconnect")
        navigationController?.tearDown()
        navigationController = nil
        audioController?.tearDown()
        audioController = nil
    }
}
