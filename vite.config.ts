import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { nitro } from "nitro/vite";

// Always-on Node server (Render). Edge/serverless presets must keep bundling everything.
const isNodeServer =
  process.env["NITRO_PRESET"] === "node-server" || Boolean(process.env["RENDER"]);

export default defineConfig(({ command }) => ({
  server: {
    port: 8080,
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      server: { entry: "server" },
    }),
    command === "build"
      ? nitro({
          // On Node, keep firebase-admin and the Google gRPC stack OUT of the bundle and load them from
          // node_modules at runtime. The bundled copy crashes on start ("__dirname is not defined in ES
          // module scope") and gRPC needs its proto files on disk. At runtime Node resolves them from the
          // project's node_modules, so the start command must run inside the installed project (Render does).
          ...(isNodeServer
            ? {
                // WebSocket live feed: server/routes/_live.ts (needs an always-on Node process).
                serverDir: "./server",
                features: { websocket: true },
                rolldownConfig: {
                  external: [
                    /^firebase-admin(\/|$)/,
                    /^@google-cloud\//,
                    /^google-gax(\/|$)/,
                    /^@grpc\//,
                  ],
                },
              }
            : {}),
          // Render (always-on Node server) is the production target: RENDER=true is set by Render itself.
          defaultPreset:
            process.env["NITRO_PRESET"] ||
            (process.env["RENDER"]
              ? "node-server"
              : process.env["VERCEL"]
                ? "vercel"
                : "cloudflare-module"),
        })
      : undefined,
    viteReact(),
  ].filter(Boolean),
}));
