# Per-track pipelines

One-off scripts that built, voiced, audited or reshaped specific tracks.
They are kept as provenance — how a track was made — not as tooling:
each reads its inputs from `../data/` (content sources, which stay out of
the code repository) and writes into the authoring database or back into
`../data/`. Nothing else imports them. The reusable paths are the generic
scripts one level up: `import-spots.ts`, `import-park-tours.ts`,
`export-track.ts`, `export-content.ts`, `publish-content.ts`.

`build-going-to-the-sun-road.ts` writes the Glacier bundle to
`../data/going-to-the-sun-road.grandtour.json`; until that tour is published
in the database, `content:export --extra scripts/data/going-to-the-sun-road.grandtour.json`
carries it into the content repository.
