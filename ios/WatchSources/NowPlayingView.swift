import SwiftUI

/// What's talking, and the three controls that matter mid-walk: pause,
/// skip, stop the tour. No transcript on the wrist.
struct NowPlayingView: View {
    @ObservedObject private var engine = WatchAppServices.shared.engine
    @ObservedObject private var player = WatchAppServices.shared.engine.player

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let s = nowPlayingSpot {
                    Text(s.spot.title)
                        .font(.headline)
                        .lineLimit(3)
                        .multilineTextAlignment(.center)
                    Text(s.track.name)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Playing")
                        .font(.headline)
                }
                if let intro = player.introText {
                    Text(intro)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                HStack(spacing: 14) {
                    Button {
                        player.toggle()
                    } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                    }
                    .buttonStyle(.bordered)
                    Button {
                        // Skip: stop this story; the idle player drives the
                        // next decision.
                        player.stop()
                    } label: {
                        Image(systemName: "forward.end.fill")
                    }
                    .buttonStyle(.bordered)
                }
                Button(role: .destructive) {
                    WatchAppServices.shared.stopTour()
                } label: {
                    Label("Stop tour", systemImage: "stop.circle")
                        .font(.footnote)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.red)
            }
        }
    }

    private var nowPlayingSpot: NearbySpot? {
        guard let id = player.nowPlayingSpotId else { return nil }
        return engine.nearby.first { $0.spot.id == id }
    }
}
