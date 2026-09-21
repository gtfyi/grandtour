import CarPlay
import MapKit
import Combine

/// Drives the CarPlay experience: a live map of the tour (car, highlights,
/// route) plus driving directions. Routing is on-device MKDirections — the
/// same engine the phone's journey sheet uses — and starting navigation also
/// starts a GrandTour journey, so narration prefetches and follows the drive.
@MainActor
final class CarPlayController: NSObject {
    private let interfaceController: CPInterfaceController
    private let window: CPWindow
    private let mapTemplate = CPMapTemplate()
    private let mapVC = CarPlayMapViewController()
    private let services = AppServices.shared
    private var cancellables: Set<AnyCancellable> = []

    // Turn-by-turn state for the active CPNavigationSession. Maneuvers are
    // MKRoute steps; each is retired when the car passes its step-end point.
    private var navigationSession: CPNavigationSession?
    private var activeTrip: CPTrip?
    private var activeRoute: MKRoute?
    private var maneuvers: [CPManeuver] = []
    private var stepEnds: [CLLocation] = []
    private var stepDistances: [CLLocationDistance] = []
    private var stepIndex = 0

    /// Search results awaiting selection, parallel to the CPListItems'
    /// userInfo indices.
    private var searchResults: [MKMapItem] = []

    private let distanceFormatter = MKDistanceFormatter()

    init(interfaceController: CPInterfaceController, window: CPWindow) {
        self.interfaceController = interfaceController
        self.window = window
        super.init()
    }

    func start() {
        window.rootViewController = mapVC
        mapTemplate.mapDelegate = self
        refreshBarButtons()
        mapTemplate.mapButtons = [recenterButton(), zoomButton(zoomIn: true), zoomButton(zoomIn: false)]
        interfaceController.setRootTemplate(mapTemplate, animated: true, completion: nil)

        // Tour on/off flips the leading play/stop button.
        services.tour.$isTouring
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.refreshBarButtons() }
            .store(in: &cancellables)
        // Every fix advances the active navigation session.
        services.location.$location
            .compactMap { $0 }
            .receive(on: RunLoop.main)
            .sink { [weak self] loc in self?.updateNavigation(with: loc) }
            .store(in: &cancellables)
    }

    func tearDown() {
        navigationSession?.cancelTrip()
        endNavigation()
        cancellables.removeAll()
    }

    // ─── Bar and map buttons ─────────────────────────────────────────────────

    private func refreshBarButtons() {
        let touring = services.tour.isTouring
        let tourButton = CPBarButton(
            image: UIImage(systemName: touring ? "stop.circle" : "play.circle")!
        ) { [weak self] _ in
            guard let self else { return }
            if self.services.tour.isTouring {
                self.services.tour.stopTour()
                self.services.location.stopTour()
            } else {
                self.services.location.startTour()
                self.services.tour.startTour(at: self.services.location.location)
            }
        }
        let highlights = CPBarButton(image: UIImage(systemName: "waveform")!) { [weak self] _ in
            self?.showHighlights()
        }
        let search = CPBarButton(image: UIImage(systemName: "magnifyingglass")!) { [weak self] _ in
            self?.showSearch()
        }
        mapTemplate.leadingNavigationBarButtons = [tourButton]
        mapTemplate.trailingNavigationBarButtons = [search, highlights]
    }

    private func recenterButton() -> CPMapButton {
        let b = CPMapButton { [weak self] _ in self?.mapVC.recenter() }
        b.image = UIImage(systemName: "location.fill")
        return b
    }

    private func zoomButton(zoomIn: Bool) -> CPMapButton {
        let b = CPMapButton { [weak self] _ in self?.mapVC.zoom(by: zoomIn ? 0.5 : 2) }
        b.image = UIImage(systemName: zoomIn ? "plus.magnifyingglass" : "minus.magnifyingglass")
        return b
    }

    // ─── Highlights list ─────────────────────────────────────────────────────

    /// Nearby spots (already distance-sorted by the server), then the journey
    /// corridor beyond them, deduped. Selecting one previews a route to it.
    private func showHighlights() {
        let tour = services.tour
        var seen = Set<String>()
        var entries: [NearbySpot] = []
        for s in tour.nearby + tour.journeySpots where seen.insert(s.spot.id).inserted {
            entries.append(s)
        }
        let items = entries.prefix(CPListTemplate.maximumItemCount).map { s -> CPListItem in
            let item = CPListItem(
                text: s.spot.title,
                detailText: "\(s.track.name) · \(distanceFormatter.string(fromDistance: s.distanceM))"
            )
            item.handler = { [weak self] _, completion in
                guard let self else { completion(); return }
                self.interfaceController.popToRootTemplate(animated: true, completion: nil)
                self.previewRoute(toName: s.spot.title, coordinate: s.coordinate)
                completion()
            }
            return item
        }
        let list = CPListTemplate(title: "Highlights", sections: [CPListSection(items: Array(items))])
        list.emptyViewTitleVariants = ["No highlights yet"]
        list.emptyViewSubtitleVariants = ["Spots appear as you approach them"]
        interfaceController.pushTemplate(list, animated: true, completion: nil)
    }

    // ─── Destination search ──────────────────────────────────────────────────

    private func showSearch() {
        let search = CPSearchTemplate()
        search.delegate = self
        interfaceController.pushTemplate(search, animated: true, completion: nil)
    }

    // ─── Routing ─────────────────────────────────────────────────────────────

    private func previewRoute(toName name: String, coordinate: CLLocationCoordinate2D) {
        guard let origin = services.location.location?.coordinate else {
            presentAlert("Waiting for a GPS fix.")
            return
        }
        Task {
            let req = MKDirections.Request()
            req.source = MKMapItem(placemark: MKPlacemark(coordinate: origin))
            let destination = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
            destination.name = name
            req.destination = destination
            req.transportType = .automobile
            guard let route = (try? await MKDirections(request: req).calculate())?.routes.first else {
                presentAlert("No route found to \(name).")
                return
            }
            let summary = self.summary(distance: route.distance, time: route.expectedTravelTime)
            let choice = CPRouteChoice(
                summaryVariants: [route.name.isEmpty ? "Route" : "Via \(route.name)"],
                additionalInformationVariants: [summary],
                selectionSummaryVariants: [summary]
            )
            let trip = CPTrip(
                origin: MKMapItem.forCurrentLocation(),
                destination: destination,
                routeChoices: [choice]
            )
            trip.userInfo = route
            self.mapVC.previewRoute(route)
            self.mapTemplate.showTripPreviews([trip], textConfiguration: CPTripPreviewTextConfiguration(
                startButtonTitle: "Go",
                additionalRoutesButtonTitle: nil,
                overviewButtonTitle: nil
            ))
        }
    }

    private func beginNavigation(trip: CPTrip, route: MKRoute) {
        // Hand the corridor to the tour: touring turns on and narration +
        // locating audio prefetch along the whole drive.
        services.location.startTour()
        Task {
            await services.tour.startJourney(
                route: JourneyPlanner.decimated(route.polyline),
                at: services.location.location
            )
        }

        activeTrip = trip
        activeRoute = route
        let steps = route.steps.filter { !$0.instructions.isEmpty }
        maneuvers = steps.map { step in
            let m = CPManeuver()
            m.instructionVariants = [step.instructions]
            m.initialTravelEstimates = CPTravelEstimates(
                distanceRemaining: Measurement(value: step.distance, unit: UnitLength.meters),
                timeRemaining: 0
            )
            return m
        }
        stepEnds = steps.map { step in
            let last = step.polyline.points()[max(0, step.polyline.pointCount - 1)]
            return CLLocation(latitude: last.coordinate.latitude, longitude: last.coordinate.longitude)
        }
        stepDistances = steps.map(\.distance)
        stepIndex = 0

        let session = mapTemplate.startNavigationSession(for: trip)
        if let first = maneuvers.first { session.upcomingManeuvers = [first] }
        navigationSession = session
        mapVC.showActiveRoute(route)
        if let loc = services.location.location { updateNavigation(with: loc) }
    }

    /// Advance maneuvers and refresh estimates from a GPS fix. Deliberately
    /// simple v1 guidance: a step retires when the car passes within 30 m of
    /// its end point; no off-route detection or rerouting yet.
    private func updateNavigation(with loc: CLLocation) {
        guard let session = navigationSession, let trip = activeTrip, let route = activeRoute else { return }
        while stepIndex < maneuvers.count, loc.distance(from: stepEnds[stepIndex]) < 30 {
            stepIndex += 1
        }
        guard stepIndex < maneuvers.count else {
            session.finishTrip()
            endNavigation()
            return
        }
        session.upcomingManeuvers = [maneuvers[stepIndex]]

        // Time scales the route's own overall estimate, so a route Apple
        // thinks takes 40 minutes doesn't show freeway ETAs on side streets.
        let speed = max(route.distance / max(route.expectedTravelTime, 1), 1)
        let toStepEnd = loc.distance(from: stepEnds[stepIndex])
        session.updateEstimates(CPTravelEstimates(
            distanceRemaining: Measurement(value: toStepEnd, unit: UnitLength.meters),
            timeRemaining: toStepEnd / speed
        ), for: maneuvers[stepIndex])

        let remaining = toStepEnd + stepDistances[(stepIndex + 1)...].reduce(0, +)
        mapTemplate.update(CPTravelEstimates(
            distanceRemaining: Measurement(value: remaining, unit: UnitLength.meters),
            timeRemaining: remaining / speed
        ), for: trip, with: .default)
    }

    /// Drop all turn-by-turn state. The tour itself stays ON — arriving (or
    /// cancelling guidance) shouldn't silence narration — but the journey's
    /// route overlay and prefetch bookkeeping are cleared. No-op when CarPlay
    /// owns no navigation, so disconnecting the car can't end a journey the
    /// phone planned.
    private func endNavigation() {
        guard activeTrip != nil else { return }
        navigationSession = nil
        activeTrip = nil
        activeRoute = nil
        maneuvers = []
        stepEnds = []
        stepDistances = []
        stepIndex = 0
        mapVC.clearRoute()
        services.tour.endJourney()
    }

    // ─── Small helpers ───────────────────────────────────────────────────────

    private func summary(distance: CLLocationDistance, time: TimeInterval) -> String {
        let mins = max(1, Int((time / 60).rounded()))
        return "\(distanceFormatter.string(fromDistance: distance)) · \(mins) min"
    }

    private func presentAlert(_ message: String) {
        let alert = CPAlertTemplate(titleVariants: [message], actions: [
            CPAlertAction(title: "OK", style: .default) { [weak self] _ in
                self?.interfaceController.dismissTemplate(animated: true, completion: nil)
            }
        ])
        interfaceController.presentTemplate(alert, animated: true, completion: nil)
    }
}

// MARK: - CPMapTemplateDelegate

extension CarPlayController: CPMapTemplateDelegate {
    func mapTemplate(_ mapTemplate: CPMapTemplate, startedTrip trip: CPTrip, using routeChoice: CPRouteChoice) {
        mapTemplate.hideTripPreviews()
        guard let route = trip.userInfo as? MKRoute else { return }
        beginNavigation(trip: trip, route: route)
    }

    func mapTemplateDidCancelNavigation(_ mapTemplate: CPMapTemplate) {
        endNavigation()
    }
}

// MARK: - CPSearchTemplateDelegate

extension CarPlayController: CPSearchTemplateDelegate {
    func searchTemplate(
        _ searchTemplate: CPSearchTemplate,
        updatedSearchText searchText: String,
        completionHandler: @escaping ([CPListItem]) -> Void
    ) {
        let trimmed = searchText.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= 2 else {
            completionHandler([])
            return
        }
        let req = MKLocalSearch.Request()
        req.naturalLanguageQuery = trimmed
        if let center = services.location.location?.coordinate {
            req.region = MKCoordinateRegion(
                center: center,
                span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
            )
        }
        MKLocalSearch(request: req).start { resp, _ in
            Task { @MainActor [weak self] in
                guard let self else {
                    completionHandler([])
                    return
                }
                self.searchResults = Array((resp?.mapItems ?? []).prefix(10))
                completionHandler(self.searchResults.enumerated().map { i, m in
                    let item = CPListItem(text: m.name ?? "Unnamed place", detailText: m.placemark.title)
                    item.userInfo = i
                    return item
                })
            }
        }
    }

    func searchTemplate(
        _ searchTemplate: CPSearchTemplate,
        selectedResult item: CPListItem,
        completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }
        guard let i = item.userInfo as? Int, searchResults.indices.contains(i) else { return }
        let dest = searchResults[i]
        interfaceController.popToRootTemplate(animated: true, completion: nil)
        previewRoute(toName: dest.name ?? "Destination", coordinate: dest.placemark.coordinate)
    }
}
