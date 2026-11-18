import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  Boxes,
  Cpu,
  History,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  PlaySquare,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { authClient } from "@/lib/auth";
import type { AuthUser } from "@/lib/auth/types";
import { devicesQuery, roomsQuery } from "@/lib/data";
import { isStale, useLive } from "@/lib/radar/live";
import { deviceConnection, EVENT_LABELS } from "@/lib/radar/types";
import { Logo } from "./logo";
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

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV_MAIN: NavItem[] = [
  { to: "/overview", label: "Dashboard", icon: LayoutDashboard },
  { to: "/live", label: "Live Radar", icon: Activity },
  { to: "/rooms", label: "Floor Plan", icon: Boxes },
  { to: "/devices", label: "Devices", icon: Cpu },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/playback", label: "Playback", icon: PlaySquare },
];
const NAV_SECONDARY: NavItem[] = [
  { to: "/events", label: "Logbook", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];
/** The four tabs always visible on a phone; everything else lives under "More". */
const MOBILE_TABS: NavItem[] = NAV_MAIN.slice(0, 4);
const MOBILE_MORE: NavItem[] = [...NAV_MAIN.slice(4), ...NAV_SECONDARY];

export function useCurrentUser(): AuthUser | null {
  const [user, setUser] = useState<AuthUser | null>(null);
  useEffect(() => {
    void authClient.getUser().then(setUser);
  }, []);
  return user;
}

export function firstName(user: AuthUser | null): string {
  const raw = user?.name?.trim() || user?.email?.split("@")[0] || "";
  const first = raw.split(/[\s._-]+/)[0] ?? "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}

export function greeting(hour: number): string {
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}

/** Real connection state of the whole system, from devices and the live feed. */
function useSystemStatus() {
  const { data: devices = [] } = useQuery(devicesQuery);
  const live = useLive();
  return useMemo(() => {
    const online = devices.filter((d) => deviceConnection(d.last_seen, live.now) === "connected");
    const receiving = Object.values(live.frames).some(
      (f) => f.ld && !isStale(f.ld.timestamp, live.now),
    );
    return { total: devices.length, online: online.length, receiving, stream: live.streamStatus };
  }, [devices, live.frames, live.now, live.streamStatus]);
}

export function LivePill({ className }: { className?: string }) {
  const s = useSystemStatus();
  const state = s.receiving
    ? { label: "Live", dot: "bg-emerald-500 animate-pulse", pill: "bg-emerald-50 text-emerald-700" }
    : s.stream === "offline"
      ? { label: "Offline", dot: "bg-slate-400", pill: "bg-slate-100 text-slate-600" }
      : { label: "Waiting", dot: "bg-amber-400", pill: "bg-amber-50 text-amber-700" };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold",
        state.pill,
        className,
      )}
      role="status"
      aria-label={`Live feed: ${state.label}`}
    >
      <span className={cn("size-2 rounded-full", state.dot)} />
      {state.label}
    </span>
  );
}

function NavLinkItem({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const active = pathname.startsWith(item.to);
  return (
    <Link
      to={item.to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors",
        active
          ? "bg-blue-600 text-white shadow-[0_8px_24px_-8px_rgba(37,99,235,0.8)]"
          : "text-slate-300 hover:bg-white/5 hover:text-white",
      )}
    >
      <item.icon className="size-[18px] shrink-0" />
      <span>{item.label}</span>
    </Link>
  );
}

function SidebarStatus() {
  const s = useSystemStatus();
  const state =
    s.total === 0
      ? { title: "No devices yet", sub: "Register one on Devices", ok: false }
      : s.online === s.total
        ? {
            title: "System Online",
            sub: s.total === 1 ? "Your device is connected" : `All ${s.total} devices connected`,
            ok: true,
          }
        : {
            title: s.online === 0 ? "System Offline" : "Partly Online",
            sub: `${s.online} of ${s.total} devices connected`,
            ok: false,
          };
  return (
    <div className="m-4 rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-white">
        <span
          className={cn(
            "size-2.5 rounded-full",
            state.ok
              ? "animate-pulse bg-emerald-400"
              : s.total === 0
                ? "bg-slate-500"
                : "bg-rose-400",
          )}
        />
        {state.title}
      </div>
      <div className="mt-1 text-xs text-slate-400">{state.sub}</div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-[260px] flex-col bg-gradient-to-b from-[#0b1437] via-[#0d1a4d] to-[#0a1130] lg:flex"
      aria-label="Sidebar"
    >
      <Link to="/overview" className="flex items-center gap-3 px-6 pb-6 pt-7">
        <Logo className="size-10 rounded-xl shadow-lg" />
        <div>
          <div className="text-lg font-bold leading-tight text-white">RoomTrace</div>
          <div className="text-xs text-slate-400">Radar Room Intelligence</div>
        </div>
      </Link>
      <nav
        className="flex-1 space-y-1 overflow-y-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Main navigation"
      >
        {NAV_MAIN.map((item) => (
          <NavLinkItem key={item.to} item={item} />
        ))}
        <div className="!my-4 h-px bg-white/10" />
        {NAV_SECONDARY.map((item) => (
          <NavLinkItem key={item.to} item={item} />
        ))}
      </nav>
      <SidebarStatus />
    </aside>
  );
}

function MobileTabBar({ onMore }: { onMore: () => void }) {
  const { pathname } = useLocation();
  const moreActive = MOBILE_MORE.some((i) => pathname.startsWith(i.to));
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      aria-label="Main navigation"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-2">
        {MOBILE_TABS.map((item) => {
          const active = pathname.startsWith(item.to);
          return (
            <li key={item.to} className="flex-1">
              <Link
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium",
                  active ? "text-blue-600" : "text-slate-500",
                )}
              >
                <item.icon className={cn("size-5", active && "stroke-[2.4]")} />
                {item.label}
              </Link>
            </li>
          );
        })}
        <li className="flex-1">
          <button
            type="button"
            onClick={onMore}
            className={cn(
              "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium",
              moreActive ? "text-blue-600" : "text-slate-500",
            )}
          >
            <MoreHorizontal className="size-5" />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const { data: rooms = [] } = useQuery(roomsQuery);
  const live = useLive();
  const [seen, setSeen] = useState(0);
  const unread = live.liveEvents.filter((e) => e.timestamp > seen).length;
  const roomName = (id: string) => rooms.find((r) => r.id === id)?.name;

  const title = pathname.startsWith("/overview")
    ? {
        main: `${greeting(new Date(live.now).getHours())}, ${firstName(user)} 👋`,
        sub: "Here's what's happening in your space today.",
      }
    : pathname.startsWith("/live")
      ? { main: "Live Radar", sub: "Real-time room monitoring" }
      : null;

  const signOut = async () => {
    await authClient.signOut();
    navigate({ to: "/auth" });
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-[#F4F7FC] text-slate-800">
      <Sidebar />

      <div className="min-w-0 lg:pl-[260px]">
        <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/80 pt-[env(safe-area-inset-top)] backdrop-blur-md">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:h-[72px] lg:px-8">
            {/* Left: logo on phones, page title on desktop */}
            <div className="flex min-w-0 items-center gap-3">
              <Link
                to="/overview"
                className="flex items-center gap-2 lg:hidden"
                aria-label="Dashboard"
              >
                <Logo className="size-8 rounded-lg" />
                <span className="text-base font-bold text-slate-900">RoomTrace</span>
              </Link>
              {title && (
                <div className="hidden min-w-0 lg:block">
                  <h1 className="truncate text-xl font-bold tracking-tight text-slate-900">
                    {title.main}
                  </h1>
                  <p className="truncate text-sm text-slate-500">{title.sub}</p>
                </div>
              )}
            </div>

            {/* Right: room, live status, alerts, account */}
            <div className="flex items-center gap-2 sm:gap-3">
              {rooms.length > 0 && (
                <Select value={live.selectedRoomId ?? ""} onValueChange={live.setSelectedRoomId}>
                  <SelectTrigger
                    className="hidden h-10 w-44 rounded-xl border-slate-200 bg-white text-sm font-medium text-slate-700 shadow-none sm:flex"
                    aria-label="Room"
                  >
                    <SelectValue placeholder="Select room" />
                  </SelectTrigger>
                  <SelectContent className="rounded-xl border-slate-200">
                    {rooms.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <LivePill />

              <Popover onOpenChange={(o) => o && setSeen(Date.now())}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="relative size-10 rounded-full text-slate-600 hover:bg-slate-100"
                    aria-label={unread > 0 ? `Alerts, ${unread} new` : "Alerts"}
                  >
                    <Bell className="size-5" />
                    {unread > 0 && (
                      <span className="absolute right-2 top-2 size-2.5 rounded-full bg-rose-500 ring-2 ring-white" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-[min(24rem,calc(100vw-2rem))] rounded-2xl border-slate-200 p-0 shadow-xl"
                >
                  <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-900">
                    Recent Activity
                  </div>
                  <ul className="scroll-thin max-h-80 overflow-auto px-4 py-2">
                    {live.liveEvents.length === 0 ? (
                      <li className="px-4 py-8 text-center text-xs text-slate-400">
                        No events yet. They appear when a device reports.
                      </li>
                    ) : (
                      live.liveEvents
                        .slice(0, 10)
                        .map((e) => (
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

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-10 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700 transition hover:bg-blue-200"
                    aria-label="Account"
                  >
                    {firstName(user).charAt(0).toUpperCase()}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-56 rounded-xl border-slate-200 p-1 shadow-lg"
                >
                  <DropdownMenuLabel className="text-xs font-normal text-slate-500">
                    Signed in as{" "}
                    <span className="block truncate font-medium text-slate-800">{user?.email}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate({ to: "/settings" })}>
                    <Settings className="mr-2 size-4 text-slate-500" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={signOut}
                    className="text-rose-600 focus:bg-rose-50 focus:text-rose-700"
                  >
                    <LogOut className="mr-2 size-4" /> Sign Out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <main className="mx-auto min-w-0 max-w-[1500px] px-4 pb-28 pt-5 sm:px-6 lg:px-8 lg:pb-10 lg:pt-7">
          {title && (
            <div className="mb-4 lg:hidden">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">{title.main}</h1>
              <p className="text-sm text-slate-500">{title.sub}</p>
            </div>
          )}
          {children}
        </main>
      </div>

      <MobileTabBar onMore={() => setMoreOpen(true)} />

      {/* "More" sheet on phones */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-3xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <SheetTitle className="sr-only">More</SheetTitle>
          <div className="mx-auto mt-1 h-1.5 w-10 rounded-full bg-slate-200" />
          <ul className="mt-4 grid grid-cols-2 gap-3">
            {MOBILE_MORE.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  onClick={() => setMoreOpen(false)}
                  className="flex min-h-14 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 active:bg-slate-50"
                >
                  <item.icon className="size-5 text-blue-600" />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={signOut}
            className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl text-sm font-medium text-rose-600 active:bg-rose-50"
          >
            <LogOut className="size-4" /> Sign Out
          </button>
        </SheetContent>
      </Sheet>
    </div>
  );
}
