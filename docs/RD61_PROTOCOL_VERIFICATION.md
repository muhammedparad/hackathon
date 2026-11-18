# RoomTrace — Ai-Thinker RD-61 Protocol Verification Specification & Readiness

**Document Version:** 1.0 (Phase 5 Hardware Integration)  
**Hardware:** Ai-Thinker RD-61 (60 GHz Millimeter-Wave Radar) mounted on RD-60-Kit Carrier  
**Target Firmware:** Firmware #2967 Standard Point Cloud V1.0.0  
**Status:** **PENDING BENCH HARDWARE VERIFICATION — DO NOT SPECULATIVELY DECODE**

---

## 1. Safety & Medical Boundaries

> [!CAUTION]
> **Prohibition of Speculative Physiological Metrics**:
> Unverified raw radar micro-Doppler signals must **NEVER** be used to infer human vital signs (such as breathing rate or heart rate), personal identity, medical distress, or physiological state. RoomTrace uses radar exclusively for spatial positioning and motion kinematics.

> [!WARNING]
> **Safety Alert Isolation**:
> Point-cloud data and cluster centroids originating from the RD-61 must remain **strictly isolated** from RoomTrace's safety-critical alerts (restricted zone ingress, hazard zone dwell, unexpected entry, and candidate fall heuristics) until the physical UART protocol has been verified on the bench with certified firmware. All safety-critical alerts continue to be driven exclusively by the HLK-LD2450.

---

## 2. Firmware #2967 Configuration & Carrier Interfacing

### 2.1 Firmware Policy

- **Selected Version:** Ai-Thinker Firmware `#2967` (Standard Point Cloud V1.0.0).
- **Prohibited Version:** Firmware `#2978` (unsupported / different communication mode).
- **Firmware Integrity:** Do NOT flash alternate binaries or switch configurations until baseline UART framing is captured with a hardware logic analyzer.

### 2.2 Carrier Board Interfacing (RD-60-Kit)

- **Carrier Interface:** RD-60-Kit evaluation module.
- **Supply Voltage:** 5.0V DC to $V_{CC}$ pin (RF transmitter requirements).
- **UART Logic Levels:** 3.3V CMOS compatible.
- **Operating Baud Rate:** 921,600 baud, 8N1 (high-bandwidth point cloud stream).

---

## 3. Protocol Verification Checklist

Before any production parser for the RD-61 is enabled in the backend or firmware, the following 8-step verification process must be completed using physical hardware:

- [ ] **Step 1: Electrical Verification**
  - Verify with a digital multimeter that the RD-60-Kit TX line idles at $3.3\text{ V} \pm 0.2\text{ V}$.
  - Verify power supply draws $< 500\text{ mA}$ at 5.0V during continuous chirp transmission.

- [ ] **Step 2: Logic Analyzer Signal Capture**
  - Connect a Saleae Logic (or equivalent logic analyzer) to RD-61 UART TX at 24 MS/s sample rate.
  - Set protocol decoder to `Async Serial, 921600 baud, 8 data bits, no parity, 1 stop bit`.
  - Capture 10 seconds of raw telemetry while a human moves in front of the antenna.

- [ ] **Step 3: Frame Delimiter Identification**
  - Inspect byte stream for candidate frame magic headers (e.g. `0x01 0x02 0x03 0x04` or `0xAA 0x55` or vendor TLV markers).
  - Verify candidate frame footers or length fields.

- [ ] **Step 4: Packet Length & Checksum Validation**
  - Record 100 consecutive frames. Determine whether frame length is fixed or dynamic (variable point count).
  - Check whether a CRC16, CRC32, or XOR checksum trailer is present.

- [ ] **Step 5: Point Coordinate Word Decoding**
  - Map candidate byte offsets to X, Y, Z spatial coordinates.
  - Test stationary targets at known measured distances ($1.0\text{ m}$, $2.0\text{ m}$, $3.0\text{ m}$).
  - Verify two's complement vs sign-magnitude representation.

- [ ] **Step 6: Doppler Velocity & SNR Scaling**
  - Confirm Doppler unit scaling ($\text{m/s}$ vs $\text{cm/s}$).
  - Confirm SNR / reflection amplitude scaling ($\text{dB}$ vs raw ADC count).

- [ ] **Step 7: Multipath & Clutter Characterization**
  - Measure noise floor in an empty room (ghost point generation from static walls).
  - Establish minimum SNR threshold for human target detection.

- [ ] **Step 8: Sign-off & Decoder Certification**
  - Commit verified byte dumps to `tests/fixtures/rd61_raw_capture.bin`.
  - Implement certified decoder matching physical fixtures.

---

## 4. Architecture: Raw Capture vs Decoded Interface

To strictly prevent speculative decoding from contaminating the production pipeline, RoomTrace adopts a clean 2-tier architecture:

```text
[ Physical RD-61 Sensor ]
           │
           ▼ (921,600 baud UART2)
[ ESP32-S3 Raw Ingest Buffer ]
           │
           ▼ (HTTPS / Raw Packet Ingestion)
[ RoomTrace Raw Data Store ] ───(Raw Diagnostics & Capture Logs)
           │
           │ (Future Certified Decoder Interface)
           ▼
[ IRD61PointDecoder ] ──(STRICTLY DISCONNECTED FROM ALERT ENGINE)──> [ 3D Visualizer ]
```

1. **Tier 1 (Raw Capture):** The ESP32 captures incoming bytes into an unparsed binary payload with timestamp and length metadata.
2. **Tier 2 (Decoder Interface):** Defines `IRD61PointDecoder` with strict return types (`RD61Point[]`). Currently defaults to a pass-through logger that refuses to generate speculative points until physical verification step 8 is satisfied.
