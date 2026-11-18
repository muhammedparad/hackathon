// Verifies the Firebase ID token a browser presents on the live WebSocket.
import { getAdminAuth } from "@/lib/firebase/admin.server";
import { demoDevicesEnabled } from "@/lib/device-auth.server";

export interface LiveIdentity {
  uid: string;
}

export async function verifyLiveToken(token: string): Promise<LiveIdentity | null> {
  if (!token || token.length > 4096) return null;

  const auth = getAdminAuth();
  if (auth) {
    try {
      const decoded = await auth.verifyIdToken(token);
      return decoded.uid ? { uid: decoded.uid } : null;
    } catch {
      return null;
    }
  }

  // No Firebase Admin credentials. Only for local testing with demo mode explicitly on:
  // read the uid from the token WITHOUT checking its signature. Never enabled in production.
  if (demoDevicesEnabled()) {
    try {
      const parts = token.split(".");
      if (parts.length === 3 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
          sub?: string;
          user_id?: string;
        };
        const uid = payload.sub || payload.user_id;
        if (uid) return { uid };
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}
