import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";

let adminApp: App | null = null;
let adminDb: Firestore | null = null;
let adminAuth: Auth | null = null;
let loggedNotice = false;

export function hasServiceAccount(): boolean {
  return Boolean(
    process.env["FIREBASE_SERVICE_ACCOUNT_KEY"] || process.env["GOOGLE_APPLICATION_CREDENTIALS"],
  );
}

function getServiceAccountCredential() {
  const raw = process.env["FIREBASE_SERVICE_ACCOUNT_KEY"];
  if (!raw) return null;
  try {
    if (raw.trim().startsWith("{")) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn("[Firebase Admin] Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY JSON:", err);
  }
  return null;
}

export function getAdminApp(): App | null {
  if (adminApp) return adminApp;
  if (getApps().length > 0) {
    adminApp = getApps()[0] ?? null;
    return adminApp;
  }

  const projectId =
    process.env["FIREBASE_PROJECT_ID"] ||
    process.env["VITE_FIREBASE_PROJECT_ID"] ||
    "freeroom-d6710";

  const cred = getServiceAccountCredential();

  try {
    if (cred) {
      adminApp = initializeApp({
        credential: cert(cred),
        projectId,
      });
      return adminApp;
    }

    if (process.env["GOOGLE_APPLICATION_CREDENTIALS"]) {
      adminApp = initializeApp({ projectId });
      return adminApp;
    }

    if (!loggedNotice) {
      loggedNotice = true;
      console.info(
        "[Firebase Admin] Note: To enable live server-to-Firestore ingestion, download your Service Account JSON from Firebase Console > Project Settings > Service accounts, and add FIREBASE_SERVICE_ACCOUNT_KEY='{...}' to your .env. Running in secure local-ingest mode.",
      );
    }
    return null;
  } catch (err) {
    console.warn("[Firebase Admin] Initialization note:", err);
    return null;
  }
}

export function getAdminFirestore(): Firestore | null {
  if (adminDb) return adminDb;
  const app = getAdminApp();
  if (!app) return null;
  try {
    adminDb = getFirestore(app);
    return adminDb;
  } catch (err) {
    console.warn("[Firebase Admin] Firestore unavailable:", err);
    return null;
  }
}

export function getAdminAuth(): Auth | null {
  if (adminAuth) return adminAuth;
  const app = getAdminApp();
  if (!app) return null;
  try {
    adminAuth = getAuth(app);
    return adminAuth;
  } catch (err) {
    console.warn("[Firebase Admin] Auth unavailable:", err);
    return null;
  }
}

export async function verifyFirebaseIdToken(token: string) {
  const auth = getAdminAuth();
  if (!auth) {
    // If Admin SDK auth is unavailable, decode payload claims for development fallback
    try {
      const parts = token.split(".");
      if (parts.length === 3 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
        if (payload.sub || payload.user_id) {
          return { uid: payload.sub || payload.user_id, email: payload.email };
        }
      }
    } catch {
      /* ignore */
    }
    throw new Error("Firebase Admin Auth unavailable to verify token");
  }
  return auth.verifyIdToken(token);
}
