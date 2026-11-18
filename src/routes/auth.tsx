import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  authClient,
  getAuthProviderType,
  setAuthProviderType,
  getAvailableProviders,
  type ProviderType,
} from "@/lib/auth";
import { Logo } from "@/components/app/logo";
import { RadarHero } from "@/components/app/hero";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Flame, ShieldCheck, Sparkles } from "lucide-react";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — RoomTrace" },
      { name: "description", content: "Sign in to monitor your rooms with mmWave radar." },
      { property: "og:title", content: "Sign in — RoomTrace" },
      { property: "og:description", content: "Sign in to monitor your rooms with mmWave radar." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentProvider, setCurrentProvider] = useState<ProviderType>(getAuthProviderType());
  const providers = getAvailableProviders();

  useEffect(() => {
    void authClient.getUser().then((user) => {
      if (user) navigate({ to: "/overview" });
    });

    const unsubscribe = authClient.onAuthStateChange((event, user) => {
      if (event === "SIGNED_IN" && user) {
        navigate({ to: "/overview" });
      }
    });

    return () => unsubscribe();
  }, [navigate]);

  const handleProviderChange = (newProvider: ProviderType) => {
    setAuthProviderType(newProvider);
    setCurrentProvider(newProvider);
    toast.success(`Switched auth provider to: ${newProvider.toUpperCase()}`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { user, error } = await authClient.signUp({ email, password });
        if (error) throw error;
        toast.success("Account created successfully!");
        if (user) navigate({ to: "/overview" });
      } else {
        const { user, error } = await authClient.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Signed in successfully!");
        if (user) navigate({ to: "/overview" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setBusy(true);
    try {
      const { user, error } = await authClient.signInWithOAuth("google");
      if (error) throw error;
      toast.success("Signed in with Google!");
      if (user) navigate({ to: "/overview" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const quickDemoLogin = async () => {
    setBusy(true);
    try {
      // Ensure we use local provider for guaranteed instant demo login
      if (currentProvider !== "local") {
        handleProviderChange("local");
      }
      const { user, error } = await authClient.signInWithPassword({
        email: "demo@roomtrace.io",
        password: "password123",
      });
      if (error) throw error;
      toast.success("Signed in as Demo User!");
      if (user) navigate({ to: "/overview" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Demo sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          {/* Header */}
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Logo />
              <span className="text-lg font-semibold tracking-tight">RoomTrace</span>
            </div>
            {/* Active Provider Pill */}
            <div className="flex items-center gap-1 rounded-full border bg-muted/60 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              {currentProvider === "firebase" ? (
                <>
                  <Flame className="size-3 text-amber-500" />
                  <span>Firebase Cloud</span>
                </>
              ) : (
                <>
                  <Sparkles className="size-3 text-primary" />
                  <span>Local Demo</span>
                </>
              )}
            </div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            See the room. Understand the movement. Without cameras.
          </p>

          {/* Quick Demo Access Button */}
          <div className="mt-5">
            <Button
              type="button"
              variant="secondary"
              className="w-full gap-2 border bg-primary/10 text-primary hover:bg-primary/20"
              onClick={quickDemoLogin}
              disabled={busy}
            >
              <Sparkles className="size-4" />
              1-Click Demo Access
            </Button>
          </div>

          <div className="my-4 flex items-center gap-3 text-xs text-foreground/50">
            <div className="h-px flex-1 bg-border" />
            <span>or continue with credentials</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Social Auth */}
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2"
            onClick={google}
            disabled={busy}
          >
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"
              />
            </svg>
            Continue with Google
          </Button>

          {/* Form */}
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="pw">Password</Label>
                {mode === "signin" && (
                  <span className="text-xs text-muted-foreground">Demo: password123</span>
                )}
              </div>
              <Input
                id="pw"
                type="password"
                required
                minLength={4}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          {/* Toggle mode */}
          <p className="mt-5 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "New to RoomTrace?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>

          {/* Auth Provider Switching Section */}
          <div className="mt-8 rounded-lg border bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-muted-foreground">Auth Provider:</span>
              <span className="font-mono text-[11px] font-semibold text-primary">
                {currentProvider.toUpperCase()}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {providers.map((p) => (
                <button
                  key={p.type}
                  type="button"
                  onClick={() => handleProviderChange(p.type)}
                  className={`rounded px-2 py-1 text-center font-medium transition-colors ${
                    currentProvider === p.type
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-background/80 hover:bg-background text-muted-foreground hover:text-foreground border"
                  }`}
                >
                  {p.type === "local" ? "Dynamic" : p.type === "firebase" ? "Firebase" : "Supabase"}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {providers.find((p) => p.type === currentProvider)?.description}
            </p>
          </div>
        </div>
      </div>

      {/* Hero Side */}
      <div className="relative hidden overflow-hidden border-l bg-card lg:block">
        <div className="absolute inset-0 [background-image:linear-gradient(var(--grid)_1px,transparent_1px),linear-gradient(90deg,var(--grid)_1px,transparent_1px)] [background-size:32px_32px]" />
        <div className="relative flex h-full flex-col justify-center gap-8 p-12">
          <div className="mx-auto w-full max-w-sm animate-fade-in">
            <RadarHero className="w-full drop-shadow-sm" />
          </div>
          <div className="mx-auto w-full max-w-sm rounded-xl border bg-card p-6 shadow-raised">
            <p className="font-mono text-xs font-semibold tracking-wider text-primary">
              24 GHz · 60 GHz mmWave
            </p>
            <p className="mt-2 text-lg font-semibold">
              Presence, position and motion — without a single camera.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              HLK-LD2450 target tracking and Ai-Thinker RD-61 point clouds, streamed from an
              ESP32-S3 to a live floor plan.
            </p>
            <ul className="mt-4 space-y-2 border-t pt-4 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-primary" />
                Live top-down room view with target trails
              </li>
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-chart-3" />
                Motion and speed from doppler
              </li>
              <li className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-success" />
                Dynamic Auth · Ready for Firebase integration
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
