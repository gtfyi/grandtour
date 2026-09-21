// bun test preload (see ../bunfig.toml). Must run before ANY test file so
// that src/db.ts — a module-level singleton — connects to the test database.
process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/grandtour_test";
process.env.ADMIN_TOKEN = "test-token";
