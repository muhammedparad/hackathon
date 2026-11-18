import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

export interface FirebaseConfig {
  apiKey?: string | undefined;
  authDomain?: string | undefined;
  projectId?: string | undefined;
  storageBucket?: string | undefined;
  messagingSenderId?: string | undefined;
  appId?: string | undefined;
}

export function getFirebaseConfig(): FirebaseConfig {
  const env =
    typeof import.meta !== "undefined"
      ? import.meta.env
      : ({} as Record<string, string | undefined>);
  return {
    apiKey: env["VITE_FIREBASE_API_KEY"],
    authDomain: env["VITE_FIREBASE_AUTH_DOMAIN"],
    projectId: env["VITE_FIREBASE_PROJECT_ID"],
    storageBucket: env["VITE_FIREBASE_STORAGE_BUCKET"],
    messagingSenderId: env["VITE_FIREBASE_MESSAGING_SENDER_ID"],
    appId: env["VITE_FIREBASE_APP_ID"],
  };
}

export function isFirebaseConfigured(): boolean {
  const config = getFirebaseConfig();
  return Boolean(config.apiKey && config.projectId);
}

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;

export function getFirebaseApp(): FirebaseApp | null {
  if (appInstance) return appInstance;
  const config = getFirebaseConfig();
  if (!config.apiKey || !config.projectId) return null;

  try {
    if (getApps().length > 0) {
      appInstance = getApp();
    } else {
      appInstance = initializeApp(config as Record<string, string>);
    }
    return appInstance;
  } catch (err) {
    console.warn("[Firebase] Initialization error:", err);
    return null;
  }
}

export function getFirebaseAuth(): Auth | null {
  if (authInstance) return authInstance;
  const app = getFirebaseApp();
  if (!app) return null;
  try {
    authInstance = getAuth(app);
    return authInstance;
  } catch (err) {
    console.warn("[Firebase] Auth initialization error:", err);
    return null;
  }
}
