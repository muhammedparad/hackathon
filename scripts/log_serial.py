#!/usr/bin/env python3
"""
RoomTrace serial logger: turns the ESP32 Serial output into CSV files you can keep, share and replay.

Works with the JSON lines printed by firmware/RoomTraceDebug (and the status lines of RoomTraceLD2450).

Live from the board (needs: pip install pyserial):
    python scripts/log_serial.py --port COM5

From text you copied out of the Arduino Serial Monitor (no hardware, no pyserial needed):
    python scripts/log_serial.py --from-file my_output.txt

Output goes to logs/<timestamp>/ (the logs/ folder is git-ignored):
    ld.csv        one row per LD2450 target per frame   (x_mm, y_mm, speed, distance, angle)
    pc.csv        one row per RD-6x point               (values are TENTATIVE until the format is verified)
    other.jsonl   every other JSON line (diag, pkt, cmd_reply, status, warn, ...) with host time
    session.log   every raw line with host time, exactly as received

Nothing is invented or smoothed: rows are exactly what the firmware printed.
"""
import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone

LD_COLS = ["host_time", "device_ms", "frame_targets", "target_id", "x_mm", "y_mm", "speed_cms", "res_mm", "dist_m", "angle_deg"]
PC_COLS = ["host_time", "frame", "offset_dw", "coord", "seq", "frag", "point_idx", "a", "b", "c", "velocity_cms", "snr_0p01db", "reserved", "tentative"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Writers:
    def __init__(self, outdir: str):
        os.makedirs(outdir, exist_ok=True)
        self.outdir = outdir
        self.ld_f = open(os.path.join(outdir, "ld.csv"), "w", newline="", encoding="utf-8")
        self.pc_f = open(os.path.join(outdir, "pc.csv"), "w", newline="", encoding="utf-8")
        self.other_f = open(os.path.join(outdir, "other.jsonl"), "w", encoding="utf-8")
        self.raw_f = open(os.path.join(outdir, "session.log"), "w", encoding="utf-8")
        self.ld = csv.writer(self.ld_f)
        self.pc = csv.writer(self.pc_f)
        self.ld.writerow(LD_COLS)
        self.pc.writerow(PC_COLS)
        self.counts = {"lines": 0, "ld_frames": 0, "ld_rows": 0, "pc_frames": 0, "pc_rows": 0, "other": 0, "unparsed": 0}

    def handle(self, line: str):
        line = line.rstrip("\r\n")
        if not line.strip():
            return
        host = now_iso()
        self.counts["lines"] += 1
        self.raw_f.write(f"{host} {line}\n")

        start = line.find("{")
        obj = None
        if start >= 0:
            try:
                obj = json.loads(line[start:])
            except json.JSONDecodeError:
                obj = None
        if not isinstance(obj, dict):
            self.counts["unparsed"] += 1
            return

        kind = obj.get("type")
        if kind == "ld":
            targets = obj.get("t", [])
            self.counts["ld_frames"] += 1
            for t in targets:
                self.ld.writerow([host, obj.get("ms"), obj.get("n"), t.get("id"), t.get("x"), t.get("y"), t.get("v"),
                                  t.get("res"), t.get("d_m"), t.get("ang")])
                self.counts["ld_rows"] += 1
            if not targets:  # keep "room empty" frames so playback sees the gaps
                self.ld.writerow([host, obj.get("ms"), obj.get("n", 0), "", "", "", "", "", "", ""])
        elif kind == "pc":
            self.counts["pc_frames"] += 1
            for i, p in enumerate(obj.get("pts", [])):
                p = list(p) + [None] * (6 - len(p))
                self.pc.writerow([host, obj.get("frame"), obj.get("offset_dw"), obj.get("coord"), obj.get("seq"),
                                  obj.get("frag"), i, p[0], p[1], p[2], p[3], p[4], p[5], obj.get("tentative", True)])
                self.counts["pc_rows"] += 1
        else:
            obj["host_time"] = host
            self.other_f.write(json.dumps(obj) + "\n")
            self.counts["other"] += 1

    def close(self):
        for f in (self.ld_f, self.pc_f, self.other_f, self.raw_f):
            f.flush()
            f.close()


def summary(w: Writers) -> str:
    c = w.counts
    return (f"lines={c['lines']}  LD frames={c['ld_frames']} (rows {c['ld_rows']})  "
            f"RD point-cloud frames={c['pc_frames']} (rows {c['pc_rows']})  other={c['other']}  unparsed={c['unparsed']}")


def run_from_file(path: str, w: Writers):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            w.handle(line)


def run_serial(port: str, baud: int, w: Writers):
    try:
        import serial  # type: ignore
    except ImportError:
        sys.exit("pyserial is not installed. Run:  pip install pyserial")
    try:
        ser = serial.Serial(port, baud, timeout=0.5)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"Cannot open {port}: {e}\nClose the Arduino Serial Monitor first (only one program can use the port).")
    print(f"Logging {port} @ {baud} -> {w.outdir}   (Ctrl+C to stop)")
    last = time.time()
    try:
        while True:
            raw = ser.readline()
            if raw:
                w.handle(raw.decode("utf-8", errors="replace"))
            if time.time() - last >= 5:
                last = time.time()
                print(summary(w))
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()


def main():
    ap = argparse.ArgumentParser(description="Log RoomTrace ESP32 serial output to CSV.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--port", help="serial port, e.g. COM5")
    src.add_argument("--from-file", help="text file with output copied from the Serial Monitor")
    ap.add_argument("--baud", type=int, default=921600, help="serial baud (default 921600, RoomTraceDebug)")
    ap.add_argument("--out", help="output folder (default logs/<timestamp>)")
    args = ap.parse_args()

    outdir = args.out or os.path.join("logs", datetime.now().strftime("%Y%m%d-%H%M%S"))
    w = Writers(outdir)
    try:
        if args.from_file:
            run_from_file(args.from_file, w)
        else:
            run_serial(args.port, args.baud, w)
    finally:
        w.close()
    print("Done. " + summary(w))
    print(f"Files in: {os.path.abspath(outdir)}")


if __name__ == "__main__":
    main()
