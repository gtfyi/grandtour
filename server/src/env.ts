/** Centralized, typed access to environment configuration. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  databaseUrl: () =>
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/grandtour",
  port: () => Number(process.env.PORT || 8787),

  // Admin API shared secret. Absent = admin API disabled (fail closed).
  adminToken: () => optional("ADMIN_TOKEN"),
  // Field diagnostics sink (/api/diag). Off unless explicitly enabled: it is
  // unauthenticated and writes location traces to disk.
  diagEnabled: () => process.env.DIAG_ENABLED === "true",
  /** The maintainer's release console at /release (see routes/release.ts); off by default so the open-source admin stays generic. */
  releaseConsole: () => process.env.RELEASE_CONSOLE === "true",
  // Origins allowed by CORS; defaults to the dev admin.
  allowedOrigins: () =>
    (process.env.ALLOWED_ORIGINS ?? "http://localhost:5180").split(","),

  // Audio storage (S3/R2-compatible). Optional in dev; uploads stub to data URLs.
  storage: {
    endpoint: () => optional("STORAGE_ENDPOINT"),
    bucket: () => optional("STORAGE_BUCKET"),
    accessKey: () => optional("STORAGE_ACCESS_KEY"),
    secretKey: () => optional("STORAGE_SECRET_KEY"),
    publicBaseUrl: () => optional("STORAGE_PUBLIC_BASE_URL"),
  },

  // The public bucket that content:publish uploads recordings to. Separate
  // from STORAGE_* on purpose: the authoring server must never write held or
  // draft audio into the public bucket; only publish does, for public tracks.
  publish: {
    endpoint: () => optional("R2_ENDPOINT"),
    bucket: () => optional("R2_BUCKET"),
    accessKey: () => optional("R2_ACCESS_KEY_ID"),
    secretKey: () => optional("R2_SECRET_ACCESS_KEY"),
  },
  // Where published recordings live: bundles name audio as
  // `${AUDIO_PUBLIC_BASE_URL}/audio/<sha256>.<ext>` (see content:export).
  audioPublicBaseUrl: () => (optional("AUDIO_PUBLIC_BASE_URL") ?? "https://data.grandtour.fyi").replace(/\/$/, ""),

  // AI providers — read lazily so the server boots without them for read-only use.
  anthropicKey: () => optional("ANTHROPIC_API_KEY"),
  anthropicBaseUrl: () => optional("ANTHROPIC_BASE_URL"),
  elevenLabsKey: () => optional("ELEVENLABS_API_KEY"),
  elevenLabsVoiceId: () => process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM",
  exaKey: () => optional("EXA_API_KEY"),
  geocodioKey: () => optional("GEOCODIO_API_KEY"),

  requireAnthropicKey: () => required("ANTHROPIC_API_KEY"),
  requireElevenLabsKey: () => required("ELEVENLABS_API_KEY"),
  requireExaKey: () => required("EXA_API_KEY"),
};
