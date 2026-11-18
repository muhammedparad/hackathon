# RoomTraceDebug

Debug-only sketch for the LD2450 and the Ai-Thinker RD-6x. No Wi-Fi, no Firebase.
It decodes the LD2450 and analyses the RD-6x as raw bytes. It never invents values.

## Setup
- Board: ESP32S3 Dev Module, **USB CDC On Boot = Enabled**, PSRAM OPI for the N16R8.
- Serial Monitor: 921600 baud, line ending "Newline".
- Wiring: LD2450 TX to GPIO18, RX to GPIO17. RD-6x data TX to GPIO4. RD-6x command port ESP TX GPIO6 / RX GPIO5. 5 V and common GND for both radars.

## Test 1: LD2450 (expect real targets)
1. Boot and wait 2 s. The `diag` line should show `ld.bytes_s` around 1000 and `frames_s` around 30.
2. Walk in front of it. `{"type":"ld",...}` lines show `x`, `y`, `v`, `d_m` and `ang`. Type `fmt text` for a readable table.
3. Pass criteria:
   - `bad_footer` stays near 0.
   - Walking left and right changes the sign of `x`.
   - Walking away from the sensor increases `y` and `d_m`.
   - Standing still gives `v=0`.
4. If `bytes_s` is 0, a `warn` line tells you what to check. If bytes arrive but there are no frames, run `cap ld` then `dump`.

## Test 2a: RD-6x official way (from the Ai-Thinker Feishu docs)
Source pages: "UART 实时数据" (packet format) and "Shell 命令使用指南" (commands).
- Needs the **point cloud firmware (#2967)**. Commands go on **UART0 at 115200**. Data comes out of **UART1**.
- The module does not stream point cloud until you start it:
  `rdstart` sends `mmwc open`, `mmwc mode 1 2`, `mmwc range 10000 40`, `mmwc veloc 3000 200`, `mmwc data 3dpoints 4`, `mmwc frame 200 10000`, `mmwc start`.
- `rdcmd mmwc` lists all shell commands. Send me that reply.
- Data packets are `A5 | check8 | 4-byte header | payload | check32`. The sketch validates check8 itself:
  - In `diag`, the `pkt` line shows `ok` (valid packets) and `bad_check8`. A steady `ok` of several per second proves the baud rate and the framing are right. A lone `ok:1` can be chance in random data.
  - MsgId `C3` = point cloud, `C1` = FFT data.
  - `{"type":"pc",...}` lines show points `[x|range, y|azimuth, z|elevation, velocity_cm_s, snr_0.01dB, reserved]`. The point field widths are **tentative** until checked against a capture.
- `rdscan` now also reports `pkt_ok` per baud. The right baud is the one with `pkt_ok > 0`.

## Test 2b: RD-6x raw analysis (fallback)
Your earlier log showed a continuous full-speed stream at 115200 baud with almost every byte non-zero. That can mean the baud rate is wrong. Do this:
1. `rdscan` tries 10 baud rates for 0.5 s each. The correct baud has **low entropy** (under 6), many zeros or ASCII text, or one dominant byte. A wrong baud has entropy near 7 to 8 and many distinct values.
2. `rdbaud <n>` to set the best one, then check `diag`.
3. `cap rd`, wait for "capture complete" (a few seconds), then `analyze`. A real frame header repeats with a steady period (`fixed_frame_len:true`). Try `analyze 2` and `analyze 3` too.
4. Record two captures (empty room, and you walking in front). Run `dump` after each and send me the text between `capture_begin` and `capture_end`. I will decode the fields from that.
5. The command port: `rdcmd <text>` or `rdhex AA 55 ...` shows replies as `cmd_reply` lines. Use the Ai-Thinker manual for valid commands.

## Saving the data to CSV (recommended)
`scripts/log_serial.py` turns the Serial output into files you can keep and send to me.

```powershell
pip install pyserial
python scripts/log_serial.py --port COM5
```
- Close the Arduino Serial Monitor first: only one program can use the port.
- Walk in front of the radars for a minute, press Ctrl+C, then send me the folder `logs/<timestamp>/`.
- Files: `ld.csv` (one row per LD2450 target), `pc.csv` (RD-6x points, tentative), `other.jsonl`
  (diag, pkt, cmd replies) and `session.log` (every raw line).
- No hardware at hand? Paste Serial Monitor text into a file and run
  `python scripts/log_serial.py --from-file my_output.txt`. In that mode all rows get the same
  `host_time`, so order them by `device_ms`.

## Not in this sketch on purpose
- Wi-Fi and Firebase. Add them back only after both sensors give verified data.
- Breathing and heart rate. They were computed from the byte sum of an unknown stream, so they were not meaningful.
