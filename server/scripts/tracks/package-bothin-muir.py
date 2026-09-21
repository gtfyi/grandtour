"""Build the app's complete pinned offline snapshot, without changing other tracks."""
import concurrent.futures
import datetime
import hashlib
import json
import pathlib
import sys
import urllib.parse
import urllib.request

TRACK_ID = "1343ada3-91f2-4704-a508-57ebff57bc12"
SERVER = (sys.argv[1] if len(sys.argv) > 1 else "http://100.80.32.94:8787").rstrip("/")
OUTPUT = pathlib.Path("/tmp/bothin-muir-offline")
digest = lambda value: hashlib.sha256(value.encode()).hexdigest()

with urllib.request.urlopen(f"{SERVER}/api/tracks/{TRACK_ID}/bundle", timeout=30) as response:
    bundle = json.load(response)
assert bundle["track"]["id"] == TRACK_ID
assert len(bundle["spots"]) == 100, "Wait for all 100 published spots"
urls = set()
for item in bundle["spots"]:
    assert item["spot"]["status"] == "published"
    assert item["spot"]["trigger"]["kind"] == "area"
    for content in item["content"]:
        assert content["status"] == "published"
        assert content["document"]["text"] and content["audioUrl"]
        urls.add(content["audioUrl"])
assert len(urls) == 100

folder = OUTPUT / digest(SERVER)
audio = folder / "audio"
audio.mkdir(parents=True, exist_ok=True)

def download(url):
    parts = urllib.parse.urlsplit(url)
    identity = parts.path + ("?" + parts.query if parts.query else "")
    name = digest(identity) + pathlib.PurePosixPath(parts.path).suffix
    target = audio / name
    # Use the active server for generated localhost URLs, as the iOS client does.
    request_url = SERVER + identity
    with urllib.request.urlopen(request_url, timeout=40) as response:
        data = response.read()
        expected = response.headers.get("Content-Length")
    assert data and (expected is None or len(data) == int(expected))
    target.write_bytes(data)
    return {"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "audioUrl": url}

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    files = list(pool.map(download, sorted(urls)))
snapshot = {"serverKey": SERVER, "downloadedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), "bundle": bundle}
snapshot_name = digest(TRACK_ID) + ".json"
(folder / snapshot_name).write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
manifest = {"trackId": TRACK_ID, "serverKey": SERVER, "directory": str(folder), "deviceDirectory": "Library/Application Support/GrandTour/downloaded-tracks/" + digest(SERVER), "snapshot": snapshot_name, "stories": len(bundle["spots"]), "recordings": len(files), "audioBytes": sum(f["bytes"] for f in files), "files": files}
(OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({k: v for k, v in manifest.items() if k != "files"}))
