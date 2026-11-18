import { LocalAuthProvider } from "./providers/local";
import { FirebaseAuthProvider } from "./providers/firebase";
import { isFirebaseConfigured } from "@/lib/firebase/config";
import type { AuthProvider, AuthResponse, AuthSession, AuthUser } from "./types";

export type ProviderType = "firebase" | "local";

const STORAGE_KEY_PROVIDER = "roomtrace_auth_provider";

const localProvider = new LocalAuthProvider();
const firebaseProvider = new FirebaseAuthProvider();

export function getAvailableProviders(): {
  type: ProviderType;
  label: string;
  available: boolean;
  description: string;
}[] {
  return [
    {
      type: "firebase",
      label: "Firebase Auth",
      available: isFirebaseConfigured(),
      description: isFirebaseConfigured()
        ? "Connected to Firebase project (freeroom-d6710)."
        : "Firebase ready! Configure VITE_FIREBASE_* in .env to activate.",
    },
    {
      type: "local",
      label: "Dynamic Local Demo",
      available: true,
      description: "Fast, offline-friendly authentication stored locally with demo accounts.",
    },
  ];
}

export function getAuthProviderType(): ProviderType {
  if (typeof window !== "undefined") {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PROVIDER) as ProviderType | null;
      if (saved && (saved === "firebase" || saved === "local")) {
        return saved;
      }
    } catch {
      /* ignore */
    }
  }

  const envType =
    typeof import.meta !== "undefined" ? import.meta.env["VITE_AUTH_PROVIDER"] : undefined;
  if (envType && (envType === "firebase" || envType === "local")) {
    return envType as ProviderType;
  }

  if (isFirebaseConfigured()) {
    return "firebase";
  }

  return "local";
}

export function setAuthProviderType(type: ProviderType) {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY_PROVIDER, type);
      window.dispatchEvent(
        new CustomEvent("roomtrace_provider_switched", { detail: { provider: type } }),
      );
    } catch {
      /* ignore */
    }
  }
}

export function getActiveProvider(): AuthProvider {
  const type = getAuthProviderType();
  if (type === "firebase" && firebaseProvider.isAvailable()) {
    return firebaseProvider;
  }
  return localProvider;
}

export const authClient: AuthProvider = {
  get name() {
    return getActiveProvider().name;
  },
  isAvailable() {
    return getActiveProvider().isAvailable();
  },
  async getUser(): Promise<AuthUser | null> {
    return getActiveProvider().getUser();
  },
  async getSession(): Promise<AuthSession | null> {
    return getActiveProvider().getSession();
  },
  async signInWithPassword(creds): Promise<AuthResponse> {
    return getActiveProvider().signInWithPassword(creds);
  },
  async signUp(creds): Promise<AuthResponse> {
    return getActiveProvider().signUp(creds);
  },
  async signInWithOAuth(provider): Promise<AuthResponse> {
    return getActiveProvider().signInWithOAuth(provider);
  },
  async signOut(): Promise<{ error: Error | null }> {
    return getActiveProvider().signOut();
  },
  async updateUser(updates): Promise<{ error: Error | null }> {
    return getActiveProvider().updateUser(updates);
  },
  async resetPassword(email: string): Promise<{ error: Error | null }> {
    const active = getActiveProvider();
    if (active.resetPassword) {
      return active.resetPassword(email);
    }
    return { error: null };
  },
  onAuthStateChange(callback) {
    return getActiveProvider().onAuthStateChange(callback);
  },
};
