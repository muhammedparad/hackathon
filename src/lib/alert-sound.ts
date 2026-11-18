// The alarm "peep" for danger-zone entries and possible falls, made with the Web Audio API (no sound files).
//
// Browsers only allow sound after the person has interacted with the page once. armAlertSound() listens for that
// first click or key press and unlocks the audio, so later alarms can play. playAlarm() says whether it could.

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

/** Unlock audio on the first interaction. Returns a function that removes the listeners. */
export function armAlertSound(): () => void {
  const unlock = () => {
    const c = context();
    if (c && c.state === "suspended") void c.resume();
  };
  const events = ["pointerdown", "keydown", "touchstart"] as const;
  for (const e of events) window.addEventListener(e, unlock, { passive: true });
  return () => {
    for (const e of events) window.removeEventListener(e, unlock);
  };
}

function tone(c: AudioContext, at: number, freq: number, len: number, volume: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  // short fade in and out so it peeps instead of clicking
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

export type AlarmKind = "danger" | "notice";

/** Three sharp peeps for danger, one soft one for an ordinary alert. False if the browser has not allowed sound yet. */
export async function playAlarm(kind: AlarmKind): Promise<boolean> {
  const c = context();
  if (!c) return false;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      return false;
    }
  }
  if (c.state !== "running") return false;
  const t0 = c.currentTime + 0.02;
  if (kind === "danger") {
    for (let i = 0; i < 3; i++) tone(c, t0 + i * 0.28, 1040, 0.18, 0.12);
  } else {
    tone(c, t0, 660, 0.22, 0.08);
  }
  return true;
}
