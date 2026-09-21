# Offline recording

On iPhone, Record is available with any server selected, including a static
site or an unreachable authoring server. Creating a track and saving a spot
commit to the phone before making any network request. Microphone and GPS
permissions are still required to record a located spot.

`RecordingLibrary` persists track identities, recording metadata, selection,
destinations and upload acknowledgements atomically to
`Documents/recordings/library.json`. Audio stays beside that file, including
after a successful upload, and can be previewed from the recording list.
Failure to save metadata leaves the take available for another save attempt.
An unreadable library is preserved rather than overwritten.

Choose the destination under **Record → Server**. `RecordingSync` retries on
network changes, server selection, foregrounding and every 30 seconds while
the app is running. iOS suspension can defer uploads until the next launch.
Static servers never receive uploads. Authoring servers must expose
`/api/creator/capabilities` with recording and idempotency support.

New tracks bind to the selected server before their first POST. Uploads use
that fixed URL; switching servers cannot redirect an in-flight request or a
previously assigned queue. The server creates the track first, then receives
spots using its returned track ID. Client-generated UUIDs and transactional
`creator_uploads` receipts make retries safe after lost responses or restarts.
The spot, narration and receipt commit together. Apply database migration
`009_creator_uploads.sql` before installing the new client.

Old `.m4a`/JSON sidecars are imported without a network connection. Since
they lack an originating server URL, they wait until the selected server's
catalog contains their original track ID. Legacy sidecars are removed only
after the library has been saved. A recording whose upload response was lost
must finish syncing before deletion, so deletion cannot leave an unknown
published copy behind.

## Verification and device installation

- 12 authoring-library tests cover offline creation, persistence, cached
  tracks, legacy recovery, read-only servers, disk failures, corrupt state,
  concurrent sync, server switches, partial uploads and lost responses.
- The existing static-server and offline-tour tests also pass: **15 native
  tests total, zero failures**.
- **13 creator API tests pass**, including concurrent retries, conflicting
  reuse of upload IDs, and a failed narration write followed by a clean retry.
- Server TypeScript checking and signed iPhone/Watch compilation pass.
- Migration 009 is applied to the local authoring server and its capability
  endpoint confirms recording and durable retries.
- Build **2026.9.21** was installed in place on `minnow` on September 20,
  2026, and launched successfully. All 371 downloaded audio files retained
  their sizes and modification times; preferences compared equal before
  first launch. The only removed pre-existing file was a system launch image.

Receipts:

- `/tmp/grandtour-offline-recording-tests-final.xcresult`
- `/tmp/grandtour-offline-recording-server-tests-final.log`
- `/tmp/grandtour-offline-recording-build-final.log`
- `/tmp/grandtour-offline-recording-install.json`
- `/tmp/grandtour-offline-recording-launch.json`
- `/tmp/grandtour-offline-recording-app-installed.json`

The tests exercise storage and HTTP recovery, not physical microphone
audibility. Local recordings can be previewed offline; GPS-triggered touring
of a newly created track becomes available after it is uploaded to a server.
