import SwiftUI
import MapKit

/// The browse surface: the user's own position (blue dot) plus a pin per
/// nearby spot. Panning away from the user re-queries `/nearby` at the map
/// center, so stories anywhere in the world can be found and played.
struct TourMapView: View {
    @ObservedObject var tour: TourViewModel
    let userLocation: CLLocation?
    @Binding var selectedSpotId: String?

    @State private var camera: MapCameraPosition = .userLocation(
        fallback: .automatic
    )
    /// Latest camera geometry, used to size the explore query.
    @State private var visibleRadiusM: Double = 2_000
    /// A demo opens fitted to its whole route with the car at the start;
    /// Start tour zooms in on the car and keeps it centered as the map
    /// scrolls underneath, until the user pans. The locate button resumes
    /// following; jumps to the next stop move the camera at once.
    @State private var followingDemo = false
    @State private var lastDemoCenter: CLLocationCoordinate2D?

    var body: some View {
        Map(position: $camera, selection: $selectedSpotId) {
            if let demo = tour.demo {
                // A demo: its route, and the car in place of the blue dot.
                MapPolyline(coordinates: demo.route)
                    .stroke(Color.orange.opacity(0.85), style: StrokeStyle(
                        lineWidth: 5, lineCap: .round, lineJoin: .round
                    ))
                if !followingDemo, let fix = tour.demoFix {
                    Annotation("Demo car", coordinate: fix.coordinate, anchor: .center) {
                        demoCar(course: fix.course)
                    }
                    .annotationTitles(.hidden)
                }
            } else {
                UserAnnotation()
            }
            if !tour.journeyRoute.isEmpty {
                MapPolyline(coordinates: tour.journeyRoute)
                    .stroke(Color.accentColor.opacity(0.7), style: StrokeStyle(
                        lineWidth: 5, lineCap: .round, lineJoin: .round
                    ))
            }
            // Journey spots not yet in nearby range, dimmed: what's ahead.
            ForEach(tour.journeySpots.filter { js in
                !tour.nearby.contains { $0.spot.id == js.spot.id }
            }) { item in
                Marker(
                    item.spot.title,
                    systemImage: item.isNarratable ? "waveform" : "mappin",
                    coordinate: item.coordinate
                )
                .tint((Color(hex: item.track.color) ?? .accentColor).opacity(0.45))
                .tag(item.spot.id as String?)
            }
            ForEach(tour.nearby) { item in
                Marker(
                    item.spot.title,
                    systemImage: item.isNarratable ? "waveform" : "mappin",
                    coordinate: item.coordinate
                )
                .tint(Color(hex: item.track.color) ?? .accentColor)
                .tag(item.spot.id as String?)
            }
            if let np = tour.player.nowPlayingSpotId,
               let playing = tour.nearby.first(where: { $0.spot.id == np }) {
                // Kind-aware highlight (matching CarPlay): an area spot IS its
                // fence — a radius circle at the centroid would be arbitrary.
                if playing.spot.trigger.isArea,
                   let ring = playing.spot.trigger.region, ring.count >= 3 {
                    MapPolygon(coordinates: ring.map {
                        CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng)
                    })
                    .foregroundStyle(Color.accentColor.opacity(0.15))
                    .stroke(Color.accentColor, lineWidth: 1)
                } else {
                    MapCircle(
                        center: playing.coordinate,
                        radius: playing.spot.trigger.radiusM
                    )
                    .foregroundStyle(Color.accentColor.opacity(0.15))
                    .stroke(Color.accentColor, lineWidth: 1)
                }
            }
        }
        .mapControls {
            if tour.demo == nil { MapUserLocationButton() }
            MapCompass()
            MapScaleView()
        }
        .overlay {
            // The camera glides between one-second fixes. Keep the car at
            // the screen center throughout, rather than placing it at the
            // next fix before the camera has reached that coordinate.
            if followingDemo, let fix = tour.demoFix {
                demoCar(course: fix.course)
                    .accessibilityLabel("Demo car")
                    .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .topTrailing) {
            // The demo's own locate button: the system one follows the phone.
            if let fix = tour.demoFix {
                Button {
                    followingDemo = true
                    followDemoCar(fix, animated: false)
                } label: {
                    Image(systemName: "location.fill")
                        .padding(10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
                .padding(.trailing, 6)
                .padding(.top, 8)
                .accessibilityLabel("Follow the demo car")
            }
        }
        .onChange(of: tour.demo?.track.id) { _, _ in
            // A demo opens on the smallest view of its whole route, the car at
            // the start; ending it hands the camera back to the phone.
            followingDemo = false
            lastDemoCenter = tour.demoFix?.coordinate
            if let demo = tour.demo {
                let region = Self.region(around: demo.route)
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { camera = .region(region) }
                visibleRadiusM = Self.radiusMeters(for: region)
            } else {
                camera = .userLocation(fallback: .automatic)
            }
        }
        .onChange(of: tour.isTouring) { _, touring in
            // Once the tour starts, zoom in and keep the car centered.
            guard touring, tour.demo != nil, let fix = tour.demoFix else { return }
            followingDemo = true
            lastDemoCenter = fix.coordinate
            withAnimation(.easeInOut(duration: 0.8)) { camera = Self.demoCamera(on: fix.coordinate, mph: tour.demo?.mph ?? 25) }
        }
        .onChange(of: tour.demoFix?.timestamp) { _, _ in
            guard followingDemo, let fix = tour.demoFix else { return }
            followDemoCar(fix, animated: true)
        }
        .onMapCameraChange(frequency: .continuous) { _ in
            // A pan during a demo takes the map from the car until the locate button.
            if tour.demo != nil, camera.positionedByUser { followingDemo = false }
        }
        .onMapCameraChange(frequency: .onEnd) { ctx in
            visibleRadiusM = Self.radiusMeters(for: ctx.region)
            // A demo's car is the traveler; a pan must not park the tour in explore mode.
            guard tour.demo == nil else { return }
            let nearUser = userLocation.map {
                distance(ctx.region.center, $0.coordinate) < 250
            } ?? true
            // Only a USER gesture may enter explore mode. Camera drift while
            // the car outruns a non-following camera must never count — that
            // silently froze whole tours in the field. Recentering happens
            // through the standard MapUserLocationButton, which restores the
            // following camera (positionedByUser == false) and lands here.
            if camera.positionedByUser && !nearUser {
                tour.exploreMapCenter(ctx.region.center, radiusM: visibleRadiusM)
            } else if tour.isExploring, nearUser, let user = userLocation {
                tour.returnToHere(user)
            }
        }
    }

    private func demoCar(course: CLLocationDirection) -> some View {
        Image(systemName: "location.north.circle.fill")
            .font(.title)
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, Color.accentColor)
            .rotationEffect(.degrees(max(0, course)))
    }

    /// The car, close enough that its pace shows: a walk closer than a drive.
    private static func demoCamera(on coordinate: CLLocationCoordinate2D, mph: Double) -> MapCameraPosition {
        .camera(MapCamera(centerCoordinate: coordinate, distance: mph * 0.44704 >= 7 ? 1_500 : 500, heading: 0, pitch: 0))
    }

    /// Glide between fixes; cut after a teleport or an explicit recenter.
    private func followDemoCar(_ fix: CLLocation, animated: Bool) {
        let teleport = lastDemoCenter.map { self.distance($0, fix.coordinate) > 500 } ?? true
        lastDemoCenter = fix.coordinate
        let target = Self.demoCamera(on: fix.coordinate, mph: tour.demo?.mph ?? 25)
        if animated && !teleport {
            withAnimation(.linear(duration: 1)) { camera = target }
        } else {
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { camera = target }
        }
    }

    private func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude)
            .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    /// A region showing a whole route, with a margin around it.
    static func region(around path: [CLLocationCoordinate2D]) -> MKCoordinateRegion {
        guard let first = path.first else {
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: 0, longitude: 0),
                                      span: MKCoordinateSpan(latitudeDelta: 90, longitudeDelta: 180))
        }
        var minLat = first.latitude, maxLat = first.latitude
        var minLng = first.longitude, maxLng = first.longitude
        for p in path {
            minLat = min(minLat, p.latitude); maxLat = max(maxLat, p.latitude)
            minLng = min(minLng, p.longitude); maxLng = max(maxLng, p.longitude)
        }
        return MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
            span: MKCoordinateSpan(latitudeDelta: max(0.01, (maxLat - minLat) * 1.3),
                                   longitudeDelta: max(0.01, (maxLng - minLng) * 1.3))
        )
    }

    /// Half the diagonal of the visible region, in meters — enough to cover
    /// the corners of what the user can see.
    private static func radiusMeters(for region: MKCoordinateRegion) -> Double {
        let latM = region.span.latitudeDelta * 111_000
        let lngM = region.span.longitudeDelta * 111_000
            * cos(region.center.latitude * .pi / 180)
        return sqrt(latM * latM + lngM * lngM) / 2
    }
}

extension NearbySpot {
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: spot.trigger.center.lat,
            longitude: spot.trigger.center.lng
        )
    }
}
