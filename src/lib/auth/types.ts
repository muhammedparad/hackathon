export interface AuthUser {
  id: string;
  email: string;
  name?: string | null | undefined;
  created_at?: string | null | undefined;
  provider: "local" | "firebase";
}

export interface AuthSession {
  user: AuthUser;
  token: string;
  expiresAt?: number | undefined;
}

export interface AuthResponse {
  user: AuthUser | null;
  error: Error | null;
}

export interface AuthProvider {
  readonly name: "local" | "firebase";
  isAvailable(): boolean;
  getUser(): Promise<AuthUser | null>;
  getSession(): Promise<AuthSession | null>;
  signInWithPassword(creds: { email: string; password: string }): Promise<AuthResponse>;
  signUp(creds: { email: string; password: string; name?: string }): Promise<AuthResponse>;
  signInWithOAuth(provider: "google"): Promise<AuthResponse>;
  signOut(): Promise<{ error: Error | null }>;
  updateUser(updates: { password?: string; name?: string }): Promise<{ error: Error | null }>;
  resetPassword?(email: string): Promise<{ error: Error | null }>;
  onAuthStateChange(
    callback: (event: "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED", user: AuthUser | null) => void,
  ): () => void;
}
