// Verifies the Firebase ID token a browser presents on the live WebSocket.
import { verifyUserToken } from "@/lib/firebase/admin.server";

export interface LiveIdentity {
  uid: string;
}

/** Strict: the token must verify against Firebase. No unsigned/dev mode exists. */
export async function verifyLiveToken(token: string): Promise<LiveIdentity | null> {
  return verifyUserToken(token);
}
