// Starts the authoring server with the maintainer's release console on
// (see src/routes/release.ts). Importing the entry keeps Bun's auto-serve
// away from the exported Hono app, which would bind the port twice.
process.env.RELEASE_CONSOLE = "true";
process.env.PORT ||= "8791";
await import("../src/index");
