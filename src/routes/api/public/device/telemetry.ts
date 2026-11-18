import { createFileRoute } from "@tanstack/react-router";
import { telemetryBodySchema } from "@/lib/radar/types";
import { authenticateDevice, json } from "@/lib/device-auth.server";
import { processTelemetry } from "@/lib/device-ingest.server";

// Processing lives in src/lib/device-ingest.server.ts, shared with the device WebSocket.
// Re-exported so existing imports (tests, diagnostics) keep working.
export {
  DEDUP_TTL_MS,
  MAX_DEDUP_CACHE_SIZE,
  ROOM_ENGINE_IDLE_TTL_MS,
  MAX_ROOM_ENGINES_SIZE,
  OCCUPANCY_CACHE_TTL_MS,
  MAX_OCCUPANCY_CACHE_SIZE,
  _resetTelemetryCache,
  _getCacheStats,
  pruneDedupCache,
  pruneRoomEngines,
  pruneOccupancyCache,
  getRoomAlertEngine,
  processTelemetry,
} from "@/lib/device-ingest.server";
export type { DedupEntry, RoomEngineEntry, OccupancyStateEntry } from "@/lib/device-ingest.server";

// POST /api/public/device/telemetry — one LD2450 or RD-61 frame from an authenticated ESP32-S3.
export const Route = createFileRoute("/api/public/device/telemetry")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateDevice(request);
        if ("error" in auth) return auth.error;

        const parsed = telemetryBodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return json({ error: "Invalid telemetry payload", issues: parsed.error.issues }, 400);
        }
        return processTelemetry(auth.device, parsed.data);
      },
    },
  },
});
