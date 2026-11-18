import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth";
import { LiveProvider } from "@/lib/radar/live";
import { AppShell } from "@/components/app/shell";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const user = await authClient.getUser();
    if (!user) throw redirect({ to: "/auth" });
  },
  component: () => (
    <LiveProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </LiveProvider>
  ),
});
