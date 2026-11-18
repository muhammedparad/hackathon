import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  updatePassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  type User as FirebaseUser,
} from "firebase/auth";
import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase/config";
import type { AuthProvider, AuthResponse, AuthSession, AuthUser } from "../types";

function toAuthUser(user: FirebaseUser): AuthUser {
  return {
    id: user.uid,
    email: user.email ?? "",
    name: user.displayName ?? user.email?.split("@")[0] ?? "User",
    created_at: user.metadata.creationTime ?? null,
    provider: "firebase",
  };
}

function formatFirebaseError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const code = (err as { code?: string }).code;
  if (code === "auth/configuration-not-found" || code === "auth/operation-not-allowed") {
    return new Error(
      "Firebase Authentication is not yet activated for this project in the Firebase Console. Go to Firebase Console > Build > Authentication > Get Started, and enable the Email/Password sign-in method.",
    );
  }
  if (
    code === "auth/invalid-credential" ||
    code === "auth/user-not-found" ||
    code === "auth/wrong-password"
  ) {
    return new Error(
      "Invalid email or password. Please verify your credentials or create an account.",
    );
  }
  if (code === "auth/email-already-in-use") {
    return new Error("This email is already registered. Please sign in instead.");
  }
  if (code === "auth/weak-password") {
    return new Error("Firebase requires a password with at least 6 characters.");
  }
  if (code === "auth/popup-closed-by-user") {
    return new Error("Google sign-in popup was closed before completing.");
  }
  return err;
}

export class FirebaseAuthProvider implements AuthProvider {
  readonly name = "firebase" as const;

  isAvailable(): boolean {
    return isFirebaseConfigured() && getFirebaseAuth() !== null;
  }

  async getUser(): Promise<AuthUser | null> {
    const auth = getFirebaseAuth();
    if (!auth) return null;
    if (auth.currentUser) return toAuthUser(auth.currentUser);

    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        unsub();
        resolve(user ? toAuthUser(user) : null);
      });
    });
  }

  async getSession(): Promise<AuthSession | null> {
    const auth = getFirebaseAuth();
    if (!auth?.currentUser) return null;
    const token = await auth.currentUser.getIdToken();
    return {
      user: toAuthUser(auth.currentUser),
      token,
    };
  }

  async signInWithPassword({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<AuthResponse> {
    const auth = getFirebaseAuth();
    if (!auth) {
      return {
        user: null,
        error: new Error(
          "Firebase is not configured. Please add your Firebase credentials to .env",
        ),
      };
    }
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      return { user: toAuthUser(credential.user), error: null };
    } catch (err) {
      return { user: null, error: formatFirebaseError(err) };
    }
  }

  async signUp({
    email,
    password,
    name,
  }: {
    email: string;
    password: string;
    name?: string;
  }): Promise<AuthResponse> {
    const auth = getFirebaseAuth();
    if (!auth) {
      return {
        user: null,
        error: new Error(
          "Firebase is not configured. Please add your Firebase credentials to .env",
        ),
      };
    }
    try {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      return { user: toAuthUser(credential.user), error: null };
    } catch (err) {
      return { user: null, error: formatFirebaseError(err) };
    }
  }

  async signInWithOAuth(provider: "google"): Promise<AuthResponse> {
    const auth = getFirebaseAuth();
    if (!auth) {
      return {
        user: null,
        error: new Error(
          "Firebase is not configured. Please add your Firebase credentials to .env",
        ),
      };
    }
    try {
      const gProvider = new GoogleAuthProvider();
      const credential = await signInWithPopup(auth, gProvider);
      return { user: toAuthUser(credential.user), error: null };
    } catch (err) {
      return { user: null, error: formatFirebaseError(err) };
    }
  }

  async signOut(): Promise<{ error: Error | null }> {
    const auth = getFirebaseAuth();
    if (!auth) return { error: null };
    try {
      await firebaseSignOut(auth);
      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  async updateUser({
    password,
  }: {
    password?: string;
    name?: string;
  }): Promise<{ error: Error | null }> {
    const auth = getFirebaseAuth();
    if (!auth?.currentUser) return { error: new Error("No authenticated Firebase user found") };
    try {
      if (password) await updatePassword(auth.currentUser, password);
      return { error: null };
    } catch (err) {
      return { error: formatFirebaseError(err) };
    }
  }

  async resetPassword(email: string): Promise<{ error: Error | null }> {
    const auth = getFirebaseAuth();
    if (!auth) return { error: new Error("Firebase is not initialized") };
    try {
      await sendPasswordResetEmail(auth, email);
      return { error: null };
    } catch (err) {
      return { error: formatFirebaseError(err) };
    }
  }

  onAuthStateChange(
    callback: (event: "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED", user: AuthUser | null) => void,
  ): () => void {
    const auth = getFirebaseAuth();
    if (!auth) return () => {};
    return onAuthStateChanged(auth, (user) => {
      if (user) {
        callback("SIGNED_IN", toAuthUser(user));
      } else {
        callback("SIGNED_OUT", null);
      }
    });
  }
}
