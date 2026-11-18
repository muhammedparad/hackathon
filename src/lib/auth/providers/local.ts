import type { AuthProvider, AuthResponse, AuthSession, AuthUser } from "../types";

interface StoredUser {
  id: string;
  email: string;
  password: string;
  name: string;
  created_at: string;
}

const STORAGE_KEY_USERS = "roomtrace_local_users";
const STORAGE_KEY_SESSION = "roomtrace_local_session";
const AUTH_EVENT_NAME = "roomtrace_auth_changed";

const SEED_USERS: StoredUser[] = [
  {
    id: "usr_admin_default",
    email: "admin@roomtrace.io",
    password: "password123",
    name: "RoomTrace Admin",
    created_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "usr_demo_default",
    email: "demo@roomtrace.io",
    password: "password123",
    name: "Demo User",
    created_at: "2026-01-01T00:00:00.000Z",
  },
];

function getStoredUsers(): StoredUser[] {
  if (typeof window === "undefined") return SEED_USERS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USERS);
    if (!raw) {
      localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(SEED_USERS));
      return SEED_USERS;
    }
    return JSON.parse(raw) as StoredUser[];
  } catch {
    return SEED_USERS;
  }
}

function saveStoredUsers(users: StoredUser[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
  } catch {
    /* ignore */
  }
}

export class LocalAuthProvider implements AuthProvider {
  readonly name = "local" as const;

  isAvailable(): boolean {
    return true;
  }

  async getUser(): Promise<AuthUser | null> {
    const session = await this.getSession();
    return session ? session.user : null;
  }

  async getSession(): Promise<AuthSession | null> {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SESSION);
      if (!raw) return null;
      return JSON.parse(raw) as AuthSession;
    } catch {
      return null;
    }
  }

  private saveSession(user: AuthUser): AuthSession {
    const session: AuthSession = {
      user,
      token: `local_token_${user.id}_${Date.now()}`,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(session));
        window.dispatchEvent(
          new CustomEvent(AUTH_EVENT_NAME, { detail: { event: "SIGNED_IN", user } }),
        );
      } catch {
        /* ignore */
      }
    }
    return session;
  }

  async signInWithPassword({
    email,
    password,
  }: {
    email: string;
    password: string;
  }): Promise<AuthResponse> {
    const cleanEmail = email.trim().toLowerCase();
    const users = getStoredUsers();
    let existing = users.find((u) => u.email.toLowerCase() === cleanEmail);

    if (!existing) {
      // In dynamic local dev mode, allow auto-creating the account on first sign in if it doesn't exist yet!
      const newUser: StoredUser = {
        id: `usr_${Math.random().toString(36).slice(2, 10)}`,
        email: cleanEmail,
        password,
        name: cleanEmail.split("@")[0] ?? "User",
        created_at: new Date().toISOString(),
      };
      users.push(newUser);
      saveStoredUsers(users);
      existing = newUser;
    } else if (existing.password && existing.password !== password) {
      return {
        user: null,
        error: new Error(
          "Invalid password for this account. Please try again or create a new account.",
        ),
      };
    }

    const authUser: AuthUser = {
      id: existing.id,
      email: existing.email,
      name: existing.name,
      created_at: existing.created_at,
      provider: "local",
    };

    this.saveSession(authUser);
    return { user: authUser, error: null };
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
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      return { user: null, error: new Error("Please enter a valid email address.") };
    }
    if (!password || password.length < 4) {
      return { user: null, error: new Error("Password must be at least 4 characters.") };
    }

    const users = getStoredUsers();
    const existingIndex = users.findIndex((u) => u.email.toLowerCase() === cleanEmail);

    const newUser: StoredUser = {
      id:
        existingIndex >= 0
          ? users[existingIndex]!.id
          : `usr_${Math.random().toString(36).slice(2, 10)}`,
      email: cleanEmail,
      password,
      name: name ?? cleanEmail.split("@")[0] ?? "User",
      created_at: existingIndex >= 0 ? users[existingIndex]!.created_at : new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      users[existingIndex] = newUser;
    } else {
      users.push(newUser);
    }
    saveStoredUsers(users);

    const authUser: AuthUser = {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      created_at: newUser.created_at,
      provider: "local",
    };

    this.saveSession(authUser);
    return { user: authUser, error: null };
  }

  async signInWithOAuth(provider: "google"): Promise<AuthResponse> {
    const googleUser: AuthUser = {
      id: "usr_google_demo",
      email: "google.user@roomtrace.io",
      name: "Google Demo User",
      created_at: new Date().toISOString(),
      provider: "local",
    };
    this.saveSession(googleUser);
    return { user: googleUser, error: null };
  }

  async signOut(): Promise<{ error: Error | null }> {
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(STORAGE_KEY_SESSION);
        window.dispatchEvent(
          new CustomEvent(AUTH_EVENT_NAME, { detail: { event: "SIGNED_OUT", user: null } }),
        );
      } catch {
        /* ignore */
      }
    }
    return { error: null };
  }

  async updateUser({
    password,
    name,
  }: {
    password?: string;
    name?: string;
  }): Promise<{ error: Error | null }> {
    const session = await this.getSession();
    if (!session?.user) return { error: new Error("No active session") };

    const users = getStoredUsers();
    const userIndex = users.findIndex((u) => u.id === session.user.id);
    if (userIndex >= 0) {
      if (password) users[userIndex]!.password = password;
      if (name) users[userIndex]!.name = name;
      saveStoredUsers(users);
    }

    const updatedUser: AuthUser = {
      ...session.user,
      name: name !== undefined ? name : session.user.name,
    };
    this.saveSession(updatedUser);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(AUTH_EVENT_NAME, { detail: { event: "USER_UPDATED", user: updatedUser } }),
      );
    }
    return { error: null };
  }

  onAuthStateChange(
    callback: (event: "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED", user: AuthUser | null) => void,
  ): () => void {
    if (typeof window === "undefined") return () => {};

    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{
        event: "SIGNED_IN" | "SIGNED_OUT" | "USER_UPDATED";
        user: AuthUser | null;
      }>;
      if (customEvent.detail) {
        callback(customEvent.detail.event, customEvent.detail.user);
      }
    };

    window.addEventListener(AUTH_EVENT_NAME, handler);
    return () => window.removeEventListener(AUTH_EVENT_NAME, handler);
  }
}
