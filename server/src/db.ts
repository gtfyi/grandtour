import postgres from "postgres";
import { env } from "./env";

/**
 * Single shared Postgres connection pool. PostGIS geometries are read back as
 * GeoJSON via ST_AsGeoJSON in queries, so we don't need a custom type parser.
 */
export const sql = postgres(env.databaseUrl(), {
  max: 10,
  // Keep BIGINT/NUMERIC as JS numbers where safe; our ids are UUID text.
  transform: { undefined: null },
  // Connection hygiene, learned the hard way: when the machine sleeps (dev
  // laptop) the pool's TCP sockets die without a FIN, and queries then queue
  // forever on zombie connections — /nearby hangs while no-DB routes work.
  // Keepalive surfaces the dead socket as an error so the pool reconnects;
  // idle recycling keeps connections young across long quiet stretches; the
  // connect timeout bounds how long a reconnect attempt can stall a query.
  keep_alive: 30,
  idle_timeout: 120,
  connect_timeout: 10,
  // No query should run long on this schema; kill runaways server-side
  // rather than letting them pin a pool slot.
  connection: { statement_timeout: 15_000 },
});

export type Sql = typeof sql;
