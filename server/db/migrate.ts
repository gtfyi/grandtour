/**
 * Minimal forward-only migration runner. Applies every db/*.sql file in
 * lexical order exactly once, tracked in a `_migrations` table.
 *
 *   bun run db/migrate.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../src/db";

const DB_DIR = import.meta.dir;

async function main() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const files = readdirSync(DB_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM _migrations`).map((r) => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`· skip   ${file}`);
      continue;
    }
    const text = readFileSync(join(DB_DIR, file), "utf8");
    console.log(`→ apply  ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`INSERT INTO _migrations (name) VALUES (${file})`;
    });
  }

  console.log("migrations up to date");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
