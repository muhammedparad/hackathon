// In-memory fan-out of live messages to connected browsers, grouped by owner (Firebase uid).
// Works on a single always-on Node process (Render). Not shared across instances.
import type { LiveServerMessage } from "./protocol";

/** Minimal socket surface the hub needs (a crossws Peer satisfies it; tests use a fake). */
export interface LivePeerLike {
  id: string;
  send(data: string): unknown;
}

export class LiveHub {
  private peers = new Map<string, { uid: string; peer: LivePeerLike }>();
  private byUid = new Map<string, Set<string>>();

  /** Register an authenticated peer to receive messages for `uid`. */
  add(uid: string, peer: LivePeerLike): void {
    this.remove(peer.id);
    this.peers.set(peer.id, { uid, peer });
    let set = this.byUid.get(uid);
    if (!set) {
      set = new Set();
      this.byUid.set(uid, set);
    }
    set.add(peer.id);
  }

  remove(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    const set = this.byUid.get(entry.uid);
    if (set) {
      set.delete(peerId);
      if (set.size === 0) this.byUid.delete(entry.uid);
    }
  }

  /** Send to every peer of `uid`. Returns how many peers were reached. A failing peer is dropped. */
  publish(uid: string, message: LiveServerMessage): number {
    const ids = this.byUid.get(uid);
    if (!ids || ids.size === 0) return 0;
    const data = JSON.stringify(message);
    let reached = 0;
    for (const id of [...ids]) {
      const entry = this.peers.get(id);
      if (!entry) continue;
      try {
        entry.peer.send(data);
        reached++;
      } catch {
        this.remove(id);
      }
    }
    return reached;
  }

  hasSubscribers(uid: string): boolean {
    return (this.byUid.get(uid)?.size ?? 0) > 0;
  }

  get size(): number {
    return this.peers.size;
  }
}

// One hub per process, even if the bundler loads this module twice (route chunk + ingest chunk).
const HUB_KEY = Symbol.for("roomtrace.live.hub");

export function getLiveHub(): LiveHub {
  const g = globalThis as unknown as Record<symbol, LiveHub | undefined>;
  return (g[HUB_KEY] ??= new LiveHub());
}
