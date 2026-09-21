import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// The middleware reads ADMIN_TOKEN lazily per request, so we can toggle it
// between requests against one app instance. None of these cases touch the
// database (auth and body validation both run before any SQL).
import app from "../src/index";

const savedToken = process.env.ADMIN_TOKEN;

beforeAll(() => {
  delete process.env.ADMIN_TOKEN;
});

afterAll(() => {
  if (savedToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = savedToken;
});

function get(path: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://localhost${path}`, { headers }));
}

describe("admin auth middleware", () => {
  test("returns 503 when ADMIN_TOKEN is not configured (fail closed)", async () => {
    delete process.env.ADMIN_TOKEN;
    const res = await get("/api/admin/tracks");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("admin_disabled");
  });

  test("returns 401 without an Authorization header", async () => {
    process.env.ADMIN_TOKEN = "test-token";
    const res = await get("/api/admin/tracks");
    expect(res.status).toBe(401);
  });

  test("returns 401 with a wrong token", async () => {
    process.env.ADMIN_TOKEN = "test-token";
    const res = await get("/api/admin/tracks", { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  test("rejects an invalid status value with 400 before touching the DB", async () => {
    process.env.ADMIN_TOKEN = "test-token";
    const res = await app.fetch(
      new Request("http://localhost/api/admin/content/00000000-0000-0000-0000-000000000000/status", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "bogus" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  test("the spot list route inherits the auth middleware", async () => {
    process.env.ADMIN_TOKEN = "test-token";
    const res = await get("/api/admin/spots");
    expect(res.status).toBe(401);
  });

  test("public routes are unaffected by admin auth", async () => {
    delete process.env.ADMIN_TOKEN;
    const res = await get("/health");
    expect(res.status).toBe(200);
  });
});
