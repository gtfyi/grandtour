import SwiftUI

/// The watch app's one root: start/stop the tour, glance the nearest story,
/// reach settings. While something is playing it swaps to the now-playing
/// screen — on a 40 mm display, one thing at a time.
struct WatchRootView: View {
    @ObservedObject private var engine = WatchAppServices.shared.engine
    @ObservedObject private var location = WatchAppServices.shared.location
    @ObservedObject private var player = WatchAppServices.shared.engine.player
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Group {
                if player.nowPlayingSpotId != nil {
                    NowPlayingView()
                } else {
                    idleContent
                }
            }
            .navigationTitle("GrandTour")
        }
    }

    private var idleContent: some View {
        ScrollView {
            VStack(spacing: 10) {
                tourButton
                if engine.needsHeadphones {
                    Label("Connect Bluetooth headphones to hear the tour.", systemImage: "airpods")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                if location.denied {
                    Label("Location is off — enable it in Settings.", systemImage: "location.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
                statusLine
                NavigationLink {
                    WatchSettingsView()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
    }

    private var tourButton: some View {
        Button {
            starting = true
            Task {
                if engine.isTouring {
                    WatchAppServices.shared.stopTour()
                } else {
                    _ = await WatchAppServices.shared.startTour()
                }
                starting = false
            }
        } label: {
            VStack(spacing: 2) {
                Image(systemName: engine.isTouring ? "stop.circle.fill" : "play.circle.fill")
                    .font(.title)
                Text(engine.isTouring ? "Stop tour" : "Start tour")
                    .font(.headline)
                if !engine.isTouring {
                    // Honest copy: starting a tour starts a workout session
                    // (that's what keeps GPS alive with the wrist down).
                    Text("Uses a workout session and headphones")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(engine.isTouring ? .red : .green)
        .disabled(starting)
    }

    @ViewBuilder
    private var statusLine: some View {
        if let s = engine.nearestUpcoming {
            VStack(spacing: 1) {
                Text(engine.isTouring ? "Up next" : "Nearest story")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(s.spot.title)
                    .font(.footnote)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                Text(watchFormatDistance(s.distanceM))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else if engine.allTracks.isEmpty && engine.error != nil {
            Text(engine.error ?? "")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        } else {
            Text("No stories nearby yet.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }
}

func watchFormatDistance(_ meters: Double) -> String {
    if Locale.current.measurementSystem == .metric {
        return meters < 1000
            ? "\(Int(meters.rounded())) m"
            : String(format: "%.1f km", meters / 1000)
    }
    let feet = meters * 3.28084
    return feet < 1000
        ? "\(Int(feet.rounded())) ft"
        : String(format: "%.1f mi", feet / 5280)
}
