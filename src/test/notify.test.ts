import { describe, expect, it } from "vitest";
import { isReminderDue, popupLevel, type Reminder } from "@/lib/notify";

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: "r1",
  user_id: "u1",
  title: "Check the living room",
  time: "09:00",
  repeat: "daily",
  date: null,
  enabled: true,
  last_fired_date: null,
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("popupLevel", () => {
  it("makes falls and critical events sticky", () => {
    expect(popupLevel({ event_type: "candidate_fall", severity: "critical" })).toBe("critical");
    expect(popupLevel({ event_type: "restricted_zone_entry", severity: "critical" })).toBe(
      "critical",
    );
  });

  it("pops up zone entries and entries away from an entry point", () => {
    expect(popupLevel({ event_type: "unexpected_entry", severity: "high" })).toBe("alert");
    expect(popupLevel({ event_type: "hazard_zone_entry", severity: "info" })).toBe("alert");
    expect(popupLevel({ event_type: "sensor_disconnected", severity: "info" })).toBe("alert");
  });

  it("keeps routine events out of the popups", () => {
    expect(popupLevel({ event_type: "door_entry", severity: "info" })).toBeNull();
    expect(popupLevel({ event_type: "room_occupied", severity: "info" })).toBeNull();
    expect(popupLevel({ event_type: "room_vacant" })).toBeNull();
  });
});

describe("isReminderDue", () => {
  const at = (iso: string) => new Date(iso); // local time, no zone suffix

  it("is not due before its time, and due from then on, once a day", () => {
    expect(isReminderDue(reminder(), at("2026-06-01T08:59:00"))).toBe(false);
    expect(isReminderDue(reminder(), at("2026-06-01T09:00:00"))).toBe(true);
    expect(isReminderDue(reminder(), at("2026-06-01T17:30:00"))).toBe(true);
  });

  it("does not repeat on the day it already fired, but is due again the next day", () => {
    const fired = reminder({ last_fired_date: "2026-06-01" });
    expect(isReminderDue(fired, at("2026-06-01T10:00:00"))).toBe(false);
    expect(isReminderDue(fired, at("2026-06-02T09:05:00"))).toBe(true);
  });

  it("only fires a one-off reminder on its own date", () => {
    const once = reminder({ repeat: "once", date: "2026-06-03" });
    expect(isReminderDue(once, at("2026-06-02T12:00:00"))).toBe(false);
    expect(isReminderDue(once, at("2026-06-03T09:01:00"))).toBe(true);
    expect(isReminderDue(once, at("2026-06-04T12:00:00"))).toBe(false);
  });

  it("never fires a switched-off or malformed reminder", () => {
    expect(isReminderDue(reminder({ enabled: false }), at("2026-06-01T12:00:00"))).toBe(false);
    expect(isReminderDue(reminder({ time: "9am" }), at("2026-06-01T12:00:00"))).toBe(false);
  });
});
