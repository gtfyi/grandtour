import React from "react";
import { createRoot } from "react-dom/client";
import { AppLoader } from "./AppLoader";
import { currentServer, serverIndexUrl } from "./server";
import { parseSimulation } from "./simulate";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";

// The web app, whatever the path: /app/ on the site, / in development. It
// reads a server's index — this origin's by default — and never needs an API.
// `?at=lat,lng` stands somewhere without GPS; `?simulate=<slug>` travels that
// track's route as a simulated trip, which is what the landing page embeds.
const params = new URLSearchParams(window.location.search);
const server = currentServer();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppLoader server={server} indexUrl={serverIndexUrl(server)} at={params.get("at")} simulate={parseSimulation(params)} />
  </React.StrictMode>,
);
