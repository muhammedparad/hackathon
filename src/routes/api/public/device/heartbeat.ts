import { createFileRoute } from "@tanstack/react-router";
import { heartbeatBodySchema } from "@/lib/radar/types";
import { authenticateDevice, json } from "@/lib/device-auth.server";
import { processHeartbeat } from "@/lib/device-ingest.server";

// POST /api/public/device/heartbeat — called by the ESP32-S3 every ~15 s.
export const Route = createFileRoute("/api/public/device/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if ("error" in auth) return auth.error;
        const body = heartbeatBodySchema.safeParse(await request.json().catch(() => ({})));
        if (!body.success) {
          return json({ error: "Invalid heartbeat", issues: body.error.issues }, 400);
        }
        return processHeartbeat(auth.device, body.data);
      },
    },
  },
});
