import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  Boxes,
  Cpu,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  PlaySquare,
  Settings,
} from "lucide-react";
import { authClient } from "@/lib/auth";
import { roomsQuery } from "@/lib/data";
import { useLive } from "@/lib/radar/live";
import { EVENT_LABELS } from "@/lib/radar/types";
import { Logo } from "./logo";
import { SimTag } from "./status";
import { EventRow } from "./event-row";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const NAV_ITEMS = [
  { to: "/overview", label: "Dashboard", icon: LayoutDashboard },
  { to: "/live", label: "Live Radar", icon: Activity },
  { to: "/events", label: "Logbook", icon: History },
  { to: "/rooms", label: "Floor Plan", icon: Boxes },
  { to: "/devices", label: "Sensors", icon: Cpu },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/playback", label: "Playback", icon: PlaySquare },
];

function useUserEmail() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    void authClient.getUser().then((user) => setEmail(user?.email ?? null));
  }, []);
  return email;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const email = useUserEmail();
  const { data: rooms = [] } = useQuery(roomsQuery);
  const live = useLive();
  const [seen, setSeen] = useState(0);
  const unread = live.liveEvents.filter((e) => e.timestamp > seen).length;
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name;

  return (
    <div className="min-h-screen bg-[#F7F9FC] text-slate-800">
      {/* Top Navbar — Pontosense / Silver Shield design system */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-4 sm:px-6">
          {/* Brand Logo & Name */}
          <div className="flex items-center gap-6">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden text-slate-600 hover:text-slate-900"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
            >
              <Menu className="size-5" />
            </Button>

            <Link to="/overview" className="flex items-center gap-2.5 transition-opacity hover:opacity-90">
              <Logo className="size-8 shadow-sm" />
              <div>
                <div className="flex items-center gap-1.5 font-bold tracking-tight text-slate-900 text-base">
                  <span>RoomTrace</span>
                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
                    Silver Shield
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 font-medium">Radar Room Intelligence</div>
              </div>
            </Link>

            {/* Desktop Navigation Links (with active bottom line indicator) */}
            <nav className="hidden lg:flex items-center gap-1 ml-4" aria-label="Main Navigation">
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "relative flex items-center gap-1.5 px-3.5 py-5 text-sm font-medium transition-colors",
                      active
                        ? "text-blue-600 font-semibold"
                        : "text-slate-600 hover:text-slate-900",
                    )}
                  >
                    <item.icon className={cn("size-4", active ? "text-blue-600" : "text-slate-400")} />
                    <span>{item.label}</span>
                    {active && (
                      <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-blue-600" />
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Right Header Actions */}
          <div className="flex items-center gap-2.5">
            {/* Room Selector */}
            {rooms.length > 0 && (
              <Select value={live.selectedRoomId ?? ""} onValueChange={live.setSelectedRoomId}>
                <SelectTrigger className="h-8.5 w-32 sm:w-40 rounded-xl border-slate-200 bg-slate-50 text-xs font-medium text-slate-700 shadow-none hover:bg-slate-100/70">
                  <SelectValue placeholder="Select room" />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-slate-200">
                  {rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id} className="text-xs">
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Mode Toggle (Hardware / Simulation) */}
            <div
              className="hidden sm:inline-flex items-center rounded-xl border border-slate-200 bg-slate-100/80 p-0.5"
              role="group"
              aria-label="Radar Mode"
            >
              {(["simulation", "hardware"] as const).map((m) => {
                const isActive = live.mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => live.setMode(m)}
                    aria-pressed={isActive}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold tracking-wide transition-all",
                      isActive
                        ? m === "simulation"
                          ? "bg-purple-100 text-purple-700 shadow-sm"
                          : "bg-emerald-500 text-white shadow-sm"
                        : "text-slate-500 hover:text-slate-800",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        isActive
                          ? m === "simulation"
                            ? "bg-purple-600"
                            : "bg-white"
                          : m === "simulation"
                            ? "bg-purple-400"
                            : "bg-emerald-500",
                      )}
                    />
                    {m === "simulation" ? "SIMULATION" : "HARDWARE"}
                  </button>
                );
              })}
            </div>

            {/* Notifications Popover (with counter badge) */}
            <Popover onOpenChange={(o) => o && setSeen(Date.now())}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-9 rounded-xl text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  aria-label="Alerts and Activity"
                >
                  <Bell className="size-4.5" />
                  {unread > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 flex size-4.5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white shadow-sm">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 sm:w-96 rounded-2xl border-slate-200 p-0 shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <span className="text-sm font-semibold text-slate-900">Recent Activity</span>
                  {live.mode === "simulation" && <SimTag />}
                </div>
                <ul className="scroll-thin max-h-80 overflow-auto px-4 py-2">
                  {live.liveEvents.length === 0 ? (
                    <li className="px-4 py-8 text-center text-xs text-slate-400">
                      No new events detected.
                    </li>
                  ) : (
                    live.liveEvents.slice(0, 10).map((e) => (
                      <EventRow
                        key={e.id}
                        dense
                        now={live.now}
                        event={{ ...e, label: EVENT_LABELS[e.event_type] }}
                        roomName={roomName(e.room_id)}
                      />
                    ))
                  )}
                </ul>
                <div className="border-t border-slate-100 p-2 text-center">
                  <Link
                    to="/events"
                    className="text-xs font-medium text-blue-600 hover:underline"
                  >
                    View complete logbook →
                  </Link>
                </div>
              </PopoverContent>
            </Popover>

            {/* User Profile Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-9 items-center justify-center rounded-full bg-blue-100 text-xs font-bold text-blue-700 shadow-sm transition hover:bg-blue-200"
                  aria-label="User Account"
                >
                  {email ? email.charAt(0).toUpperCase() : "N"}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 rounded-xl border-slate-200 p-1 shadow-lg">
                <DropdownMenuLabel className="font-normal text-xs text-slate-500">
                  Signed in as <span className="font-medium text-slate-800">{email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate({ to: "/settings" })}>
                  <Settings className="size-4 mr-2 text-slate-500" /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async () => {
                    await authClient.signOut();
                    navigate({ to: "/auth" });
                  }}
                  className="text-rose-600 focus:text-rose-700 focus:bg-rose-50"
                >
                  <LogOut className="size-4 mr-2" /> Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Mobile Drawer Navigation */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0 bg-white">
          <SheetTitle className="sr-only">Mobile Navigation</SheetTitle>
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2.5 p-5 border-b border-slate-100">
              <Logo className="size-7" />
              <div>
                <div className="font-bold text-slate-900 text-sm">RoomTrace</div>
                <div className="text-[10px] text-slate-400">Silver Shield System</div>
              </div>
            </div>
            <nav className="flex-1 space-y-1 p-3">
              {NAV_ITEMS.map((item) => {
                const active = pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition",
                      active
                        ? "bg-blue-50 text-blue-600 font-semibold"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                    )}
                  >
                    <item.icon className={cn("size-4.5", active ? "text-blue-600" : "text-slate-400")} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
            <div className="border-t border-slate-100 p-4">
              <div className="text-xs text-slate-400 mb-2">Sensor Connection</div>
              <div className="flex items-center gap-2 text-xs font-medium text-emerald-600">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                {live.streamStatus === "live" ? "Realtime Active" : "Online"}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Main Page Canvas Container */}
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
