"""Verify the published sheriff track, preserved originals, and new recordings.

Run from the repo root: python3 server/scripts/audit-sheriff-calls.py
"""
import concurrent.futures
import datetime
import json
import pathlib
import subprocess
import urllib.parse
import urllib.request

root = pathlib.Path(__file__).resolve().parents[3]
data = root / "server/scripts/data"
slate = json.loads((data / "point-reyes-light-sheriff-calls.spots.json").read_text())
addition = json.loads((data / "sheriff-calls-additions-2026-09-13.spots.json").read_text())
prior = json.loads((root / "docs/sheriff-track-separation-before-2026-09-13.json").read_text())
base = "http://localhost:8787"


def get(path):
    with urllib.request.urlopen(base + path, timeout=20) as response:
        return json.load(response)


tracks = get("/api/tracks")["tracks"]
track = next(t for t in tracks if t["slug"] == slate["track"]["slug"])
bundle = get("/api/tracks/" + track["id"] + "/bundle")
assert track["spotCount"] == len(bundle["spots"]) == len(slate["spots"])
manifest = get("/api/track-manifest?tracks=" + track["slug"])["tracks"][0]
assert len(manifest["units"]) == len(slate["spots"])
authored = {s["title"]: s for s in slate["spots"]}
old = {s["id"]: s for s in prior["spots"]}
new_titles = {s["title"] for s in addition["spots"]}


def check(item):
    spot = item["spot"]
    content = next(c for c in item["content"] if c["locale"] == "en" and c["variant"] == "default")
    script = authored[spot["title"]]
    exact = " ".join(f"{e['date']}. {e['town']}. {e['report']}" for e in script["reportEntries"])
    assert content["document"]["text"] == script["narration"] == exact
    assert spot["status"] == content["status"] == "published"
    assert content["audioUrl"] and content["durationMs"] > 0
    assert content["provenance"]["ttsProvider"] == "elevenlabs"
    assert {s["url"] for s in content["provenance"]["sources"]} == set(script["sources"])
    if spot["id"] in old:
        previous = next(c for c in old[spot["id"]]["content"] if c["id"] == content["id"])
        assert previous["audioUrl"] == content["audioUrl"]
    if spot["title"] in new_titles:
        assert content["source"] == "imported"
    audio_tier = next(t for t in content["document"]["tiers"] if t["id"] == "audio")
    assert audio_tier["annotations"]
    for annotation in audio_tier["annotations"]:
        assert 0 <= annotation["start"] <= annotation["end"] <= len(exact.encode())
    path = urllib.parse.urlsplit(content["audioUrl"]).path
    request = urllib.request.Request(base + path, headers={"Range": "bytes=0-1023"})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 206 and len(response.read()) == 1024
    local = root / "server" / urllib.parse.unquote(path.lstrip("/"))
    decode = subprocess.run(["ffmpeg", "-v", "error", "-i", str(local), "-f", "null", "-"], capture_output=True)
    assert decode.returncode == 0, decode.stderr.decode()
    return dict(id=spot["id"], title=spot["title"], contentId=content["id"],
                audioUrl=content["audioUrl"], durationMs=content["durationMs"],
                new=spot["title"] in new_titles, exactTranscript=True, decoded=True, byteRangeStatus=206)


with concurrent.futures.ThreadPoolExecutor(4) as pool:
    checks = list(pool.map(check, bundle["spots"]))
assert len({s["id"] for s in checks}) == len(checks)
assert len([s for s in checks if s["new"]]) == len(addition["spots"])
assert {s["id"] for s in checks if s["id"] in old} == set(old)

locations = [("Nicasio", 38.041871, -122.684498), ("Shell Beach", 38.1238, -122.9027)]
for label, lat, lng in locations:
    # Match installed phones, which omit the limit parameter.
    query = urllib.parse.urlencode(dict(lat=lat, lng=lng, radiusM=2000, tracks=track["slug"]))
    feed = get("/api/nearby?" + query)
    assert len(feed["spots"]) == len(checks), label
    assert all(s["triggered"] for s in feed["spots"]), label

drive = next(t for t in tracks if t["slug"] == "fairfax-point-reyes-archive-drive")
drive_bundle = get("/api/tracks/" + drive["id"] + "/bundle")
assert not any(s["spot"]["title"].startswith("Sheriff’s Calls:") for s in drive_bundle["spots"])
audit = dict(verifiedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
             track=track, totalRecordings=len(checks),
             totalCalls=sum(len(s["reportEntries"]) for s in slate["spots"]),
             newRecordings=sum(s["new"] for s in checks),
             newMinutes=sum(s["durationMs"] for s in checks if s["new"]) / 60000,
             totalMinutes=sum(s["durationMs"] for s in checks) / 60000,
             originalRecordingsPreserved=True, allTriggerAtBothLocations=True,
             originalDriveHasNoCalls=True, checks=checks)
(root / "docs/sheriff-new-calls-audio-audit-2026-09-13.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({k: v for k, v in audit.items() if k not in ["checks", "track"]}, indent=2))
