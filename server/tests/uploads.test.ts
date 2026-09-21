import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import app from "../src/index";
import { localUploadsDir } from "../src/ai/storage";

const FIXTURE = "test-fixture.mp3";
const fixturePath = join(localUploadsDir, FIXTURE);

beforeAll(async () => {
  await Bun.write(fixturePath, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
});

afterAll(async () => {
  await Bun.file(fixturePath).delete();
});

function get(path: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

describe("/uploads key validation", () => {
  test("rejects percent-encoded traversal (the decode-order bug)", async () => {
    const res = await get("/uploads/%2e%2e/etc/passwd");
    expect(res.status).toBe(404);
  });

  test("rejects raw dot-dot traversal", async () => {
    // Hand-built Requests don't normalize the path, unlike most HTTP clients.
    const res = await get("/uploads/../etc/passwd");
    expect(res.status).toBe(404);
  });

  test("rejects malformed percent-encoding without throwing", async () => {
    const res = await get("/uploads/%zz");
    expect(res.status).toBe(404);
  });

  test("404s a well-formed key with no object behind it", async () => {
    const res = await get("/uploads/no-such-file.mp3");
    expect(res.status).toBe(404);
  });
});

describe("/uploads serving", () => {
  test("serves a whole file with byte-range support advertised", async () => {
    const res = await get(`/uploads/${FIXTURE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("8");
  });

  test("serves a partial range with 206 and correct length", async () => {
    const res = await get(`/uploads/${FIXTURE}`, { Range: "bytes=0-1" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-length")).toBe("2");
    expect(res.headers.get("content-range")).toBe("bytes 0-1/8");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  test("returns 416 for an unsatisfiable range", async () => {
    const res = await get(`/uploads/${FIXTURE}`, { Range: "bytes=99-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */8");
  });
});
