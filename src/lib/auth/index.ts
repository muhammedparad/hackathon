import { FirebaseAuthProvider } from "./providers/firebase";
import type { AuthProvider, AuthResponse, AuthSession, AuthUser } from "./types";

/** Authentication is Firebase only. There is no local or demo account provider. */
const firebaseProvider = new FirebaseAuthProvider();

export const authClient: AuthProvider = {
  get name() {
    return firebaseProvider.name;
  },
  isAvailable() {
    return firebaseProvider.isAvailable();
  },
  async getUser(): Promise<AuthUser | null> {
    return firebaseProvider.getUser();
  },
  async getSession(): Promise<AuthSession | null> {
    return firebaseProvider.getSession();
  },
  async signInWithPassword(creds): Promise<AuthResponse> {
    return firebaseProvider.signInWithPassword(creds);
  },
  async signUp(creds): Promise<AuthResponse> {
    return firebaseProvider.signUp(creds);
  },
  async signInWithOAuth(provider): Promise<AuthResponse> {
    return firebaseProvider.signInWithOAuth(provider);
  },
  async signOut(): Promise<{ error: Error | null }> {
    return firebaseProvider.signOut();
  },
  async updateUser(updates): Promise<{ error: Error | null }> {
    return firebaseProvider.updateUser(updates);
  },
  async resetPassword(email: string): Promise<{ error: Error | null }> {
    if (firebaseProvider.resetPassword) return firebaseProvider.resetPassword(email);
    return { error: null };
  },
  onAuthStateChange(callback) {
    return firebaseProvider.onAuthStateChange(callback);
  },
};
