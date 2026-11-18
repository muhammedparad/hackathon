/*
  RoomTrace sensor debug firmware (ESP32-S3)  -  LD2450 + Ai-Thinker RD-6x

  Purpose: see exactly what each radar sends, with NO Wi-Fi / Firebase involved.
  Nothing is invented: LD2450 values are decoded from the datasheet frame;
  the RD-6x is only analysed as raw bytes until its protocol is known.

  Wiring (same as your current build)
    LD2450  TX -> GPIO18 (ESP RX),  RX -> GPIO17 (ESP TX), 5V, GND, 256000 baud
    RD-6x   data TX -> GPIO4 (ESP RX), 5V, GND, baud changeable (default 115200)
    RD-6x   command UART: ESP TX GPIO6 -> radar RX, ESP RX GPIO5 <- radar TX

  Arduino IDE: board "ESP32S3 Dev Module", USB CDC On Boot = ENABLED
  (UART0 is reused for the RD-6x command port, so Serial must be USB).
  Serial Monitor: 921600 baud, line ending "Newline".

  Type  help  in the Serial Monitor.
*/

#include <Arduino.h>
#include <math.h>

// ---------------- pins / bauds ----------------
static constexpr int      LD_RX_PIN  = 18;
static constexpr int      LD_TX_PIN  = 17;
static constexpr uint32_t LD_BAUD    = 256000;

static constexpr int      RD_RX_PIN  = 4;
static uint32_t           rdBaud     = 115200;

static constexpr int      RDC_RX_PIN = 5;
static constexpr int      RDC_TX_PIN = 6;
static constexpr uint32_t RDC_BAUD   = 115200;

static constexpr uint32_t USB_BAUD   = 921600;

static constexpr uint32_t DIAG_MS      = 2000;
static constexpr uint32_t LD_PRINT_MS  = 200;   // max 5 target prints / second
static constexpr size_t   CAP_SIZE     = 32768; // raw capture buffer

HardwareSerial LdSerial(1);
HardwareSerial RdSerial(2);
HardwareSerial RdCmdSerial(0);

// ---------------- LD2450 ----------------
struct LdTarget {
  bool on = false;
  int16_t x = 0, y = 0, v = 0;
  uint16_t res = 0;
};

static const uint8_t LD_HDR[4] = {0xAA, 0xFF, 0x03, 0x00};
static uint8_t  ldBuf[30];
static size_t   ldIdx = 0;
static LdTarget ldT[3];
static uint8_t  ldCount = 0;
static uint32_t ldLastFrameMs = 0;
static bool     ldNewFrame = false;
static uint32_t ldBytes = 0, ldFrames = 0, ldBadFooter = 0, ldResync = 0; // per diag window

// ---------------- RD-6x raw stats ----------------
static uint32_t rdBytes = 0;
static uint32_t rdHist[256];

// ---------------- capture ----------------
static uint8_t *capBuf = nullptr;
static size_t   capLen = 0;
static uint8_t  capSrc = 0;       // 0 idle, 1 RD-6x, 2 LD2450 (capture running)
static uint8_t  capLastSrc = 0;   // which sensor the stored capture came from
static uint32_t capBaud = 0;
static bool     capDone = false;

// ---------------- RD-6x start sequence ----------------
// Official sequence from the Ai-Thinker "Shell 命令使用指南" (command UART0, 115200 baud).
static const char *const RD_START_SEQ[] = {
    "mmwc open", "mmwc mode 1 2", "mmwc range 10000 40", "mmwc veloc 3000 200",
    "mmwc data 3dpoints 4", "mmwc frame 200 10000", "mmwc start"};
static constexpr int RD_START_N = sizeof(RD_START_SEQ) / sizeof(RD_START_SEQ[0]);
static int      seqIdx = -1;
static uint32_t seqNextMs = 0;

// ---------------- misc ----------------
static bool     textMode = false;
static uint32_t lastDiagMs = 0, lastLdPrintMs = 0;
static String   hostLine;
static uint8_t  cmdReply[512];
static size_t   cmdReplyLen = 0;
static uint32_t cmdLastByteMs = 0;

// ================= helpers =================
static void printBytesAsText(const uint8_t *p, size_t n);  // defined below, used by commands

static inline void capPush(uint8_t src, uint8_t b) {
  if (capSrc == src && capBuf && capLen < CAP_SIZE) {
    capBuf[capLen++] = b;
    if (capLen == CAP_SIZE) {
      capLastSrc = capSrc;
      capSrc = 0;
      capDone = true;
    }
  }
}

static int16_t decodeSigned(const uint8_t *p) {
  const uint16_t raw = (uint16_t)p[0] | ((uint16_t)p[1] << 8);
  const int16_t mag = (int16_t)(raw & 0x7FFF);
  return (raw & 0x8000) ? mag : -mag;   // bit15 = 1 -> positive (LD2450 datasheet)
}

static uint16_t decodeU16(const uint8_t *p) {
  return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

// ================= LD2450 parser =================
static void ldDecode() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < 3; ++i) {
    const uint8_t *p = &ldBuf[4 + i * 8];
    LdTarget &t = ldT[i];
    t.x = decodeSigned(p);
    t.y = decodeSigned(p + 2);
    t.v = decodeSigned(p + 4);
    t.res = decodeU16(p + 6);
    t.on = !(t.x == 0 && t.y == 0 && t.v == 0 && t.res == 0);
    if (t.on) ++n;
  }
  ldCount = n;
  ldLastFrameMs = millis();
  ldNewFrame = true;
  ++ldFrames;
}

static void ldFeed(uint8_t b);

static void ldRecover() {
  // bad footer: re-scan the rejected bytes for a header that started inside them
  uint8_t tmp[30];
  const size_t n = ldIdx;
  memcpy(tmp, ldBuf, n);
  ldIdx = 0;
  for (size_t i = 1; i < n; ++i) ldFeed(tmp[i]);
}

static void ldFeed(uint8_t b) {
  if (ldIdx < 4) {
    if (b == LD_HDR[ldIdx]) {
      ldBuf[ldIdx++] = b;
    } else {
      if (ldIdx > 0) ++ldResync;
      ldIdx = 0;
      if (b == LD_HDR[0]) ldBuf[ldIdx++] = b;
    }
    return;
  }
  ldBuf[ldIdx++] = b;
  if (ldIdx == sizeof(ldBuf)) {
    if (ldBuf[28] == 0x55 && ldBuf[29] == 0xCC) {
      ldDecode();
      ldIdx = 0;
    } else {
      ++ldBadFooter;
      ldRecover();
    }
  }
}

static void pumpLd() {
  while (LdSerial.available() > 0) {
    const uint8_t b = (uint8_t)LdSerial.read();
    ++ldBytes;
    capPush(2, b);
    ldFeed(b);
  }
}

// ---------------- Ai-Thinker Rd-6x UART packet (from "UART 实时数据" doc) ----------------
//   A5 | check8 | MsgHeader[4] | [ext 4 if Ext=1] | payload[Length] | [check32 4 if Check=1]
//   check8 = ~(A5 + 4 header bytes)            -> used here to VALIDATE that we frame correctly
//   header (little-endian): b0 = Type(2) Req Enc Check More Ext Mac ; b1 = MsgId ;
//                           b2..b3 = Length(12) Seq(3) Frag(1)
//   MsgId 0xC1 = FFT data, 0xC3 = point cloud
static constexpr size_t PKT_MAX = 6 + 4 + 4095 + 4;
static uint8_t  pkt[PKT_MAX];
static size_t   pktLen = 0, pktNeed = 0;
static uint32_t pktOk = 0, pktBad8 = 0;
static uint8_t  pktIds[8];
static uint32_t pktIdCnt[8];
static bool     pktQuiet = false;
static uint8_t  pcLastFlag = 0;

static void pktCount(uint8_t id) {
  for (int i = 0; i < 8; ++i) {
    if (pktIdCnt[i] && pktIds[i] == id) { ++pktIdCnt[i]; return; }
  }
  for (int i = 0; i < 8; ++i) {
    if (!pktIdCnt[i]) { pktIds[i] = id; pktIdCnt[i] = 1; return; }
  }
}

static uint32_t rdU32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static int16_t rdI16(const uint8_t *p) { return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8)); }

// Point-cloud payload layout is TENTATIVE: taken from the doc diagram, field widths not verified yet.
static void decodePointCloud(const uint8_t *p, size_t n, uint8_t seq, bool frag) {
  if (n < 12) return;
  const uint32_t frameIdx = rdU32(p), frameLenDw = rdU32(p + 4), offDw = rdU32(p + 8);
  size_t pos = 12;
  uint8_t dtype = 0;
  uint16_t totalBytes = 0;
  if (offDw == 0) {
    if (n < 16) return;
    dtype = p[12];
    pcLastFlag = p[13];
    totalBytes = (uint16_t)(p[14] | (p[15] << 8));
    pos = 16;
  }
  const size_t np = (n - pos) / 12;
  Serial.printf("{\"type\":\"pc\",\"tentative\":true,\"frame\":%lu,\"frame_len_dw\":%lu,\"offset_dw\":%lu,"
                "\"data_type\":%u,\"total_bytes\":%u,\"coord\":\"%s\",\"seq\":%u,\"frag\":%u,\"n\":%u,\"pts\":[",
                (unsigned long)frameIdx, (unsigned long)frameLenDw, (unsigned long)offDw, (unsigned)dtype,
                (unsigned)totalBytes, (pcLastFlag & 1) ? "cartesian_cm" : "polar", (unsigned)seq, (unsigned)frag,
                (unsigned)np);
  const size_t shown = np < 16 ? np : 16;
  for (size_t i = 0; i < shown; ++i) {
    const uint8_t *q = p + pos + i * 12;
    // [range|x, azimuth|y, elevation|z, velocity_cm_s, snr_0.01dB, reserved]
    Serial.printf("%s[%d,%d,%d,%d,%d,%d]", i ? "," : "", rdI16(q), rdI16(q + 2), rdI16(q + 4), rdI16(q + 6),
                  rdI16(q + 8), rdI16(q + 10));
  }
  Serial.println("]}");
}

static void pktComplete() {
  ++pktOk;
  const uint8_t h0 = pkt[2], msgId = pkt[3];
  const uint16_t w = (uint16_t)(pkt[4] | (pkt[5] << 8));
  const uint16_t length = w & 0x0FFF;
  const uint8_t seq = (w >> 12) & 7;
  const bool frag = (w >> 15) & 1;
  const bool ext = (h0 >> 6) & 1;
  pktCount(msgId);
  if (pktQuiet) return;
  if (msgId == 0xC3) decodePointCloud(pkt + 6 + (ext ? 4 : 0), length, seq, frag);
}

static void pktFeed(uint8_t b);

static void pktResync() {
  uint8_t tmp[6];
  const size_t n = pktLen;
  memcpy(tmp, pkt, n);
  pktLen = 0;
  for (size_t i = 1; i < n; ++i) pktFeed(tmp[i]);
}

static void pktFeed(uint8_t b) {
  if (pktLen == 0) {
    if (b == 0xA5) pkt[pktLen++] = b;
    return;
  }
  pkt[pktLen++] = b;
  if (pktLen < 6) return;
  if (pktLen == 6) {
    const uint8_t sum = (uint8_t)(pkt[0] + pkt[2] + pkt[3] + pkt[4] + pkt[5]);
    if ((uint8_t)(~sum) != pkt[1]) {
      ++pktBad8;
      pktResync();
      return;
    }
    const uint8_t h0 = pkt[2];
    const uint16_t length = (uint16_t)(pkt[4] | (pkt[5] << 8)) & 0x0FFF;
    pktNeed = 6 + (((h0 >> 6) & 1) ? 4 : 0) + length + (((h0 >> 4) & 1) ? 4 : 0);
    if (pktNeed > PKT_MAX) { pktLen = 0; return; }
    if (pktNeed == 6) {      // header-only packet (no payload, no checksum)
      pktComplete();
      pktLen = 0;
    }
    return;
  }
  if (pktLen == pktNeed) {
    pktComplete();
    pktLen = 0;
  }
}

static void pumpRd() {
  while (RdSerial.available() > 0) {
    const uint8_t b = (uint8_t)RdSerial.read();
    ++rdBytes;
    ++rdHist[b];
    capPush(1, b);
    pktFeed(b);
  }
}

static void startRdSerial() {
  RdSerial.end();
  RdSerial.setRxBufferSize(8192);
  RdSerial.begin(rdBaud, SERIAL_8N1, RD_RX_PIN, -1);
  memset(rdHist, 0, sizeof(rdHist));
  rdBytes = 0;
}

// ================= output =================
static void printLdFrame() {
  const uint32_t now = millis();
  if (textMode) {
    Serial.printf("LD2450  targets=%u\n", (unsigned)ldCount);
  } else {
    Serial.printf("{\"type\":\"ld\",\"ms\":%lu,\"n\":%u,\"t\":[", (unsigned long)now, (unsigned)ldCount);
  }
  bool first = true;
  for (uint8_t i = 0; i < 3; ++i) {
    const LdTarget &t = ldT[i];
    if (!t.on) continue;
    const float d = sqrtf((float)t.x * t.x + (float)t.y * t.y) / 1000.0f;
    const float ang = atan2f((float)t.x, (float)t.y) * 57.29578f; // 0 deg = straight ahead
    if (textMode) {
      Serial.printf("  T%u x=%6d mm  y=%6d mm  v=%4d cm/s  res=%4u mm  dist=%.2f m  angle=%.1f deg\n",
                    (unsigned)(i + 1), t.x, t.y, t.v, (unsigned)t.res, d, ang);
    } else {
      Serial.printf("%s{\"id\":%u,\"x\":%d,\"y\":%d,\"v\":%d,\"res\":%u,\"d_m\":%.2f,\"ang\":%.1f}",
                    first ? "" : ",", (unsigned)(i + 1), t.x, t.y, t.v, (unsigned)t.res, d, ang);
      first = false;
    }
  }
  if (!textMode) Serial.println("]}");
}

static void printDiag(uint32_t now) {
  const float secs = DIAG_MS / 1000.0f;

  // top 4 byte values of the RD-6x stream in this window
  uint32_t tmp[256];
  memcpy(tmp, rdHist, sizeof(tmp));
  int topB[4];
  uint32_t topC[4];
  uint16_t distinct = 0;
  for (int b = 0; b < 256; ++b) if (rdHist[b]) ++distinct;
  for (int k = 0; k < 4; ++k) {
    int best = -1;
    uint32_t bc = 0;
    for (int b = 0; b < 256; ++b) {
      if (tmp[b] > bc) { bc = tmp[b]; best = b; }
    }
    topB[k] = best;
    topC[k] = bc;
    if (best >= 0) tmp[best] = 0;
  }

  const long ldAge = ldLastFrameMs ? (long)(now - ldLastFrameMs) : -1L;

  if (textMode) {
    Serial.printf("[diag] LD2450: %lu B/s, %lu frames/s, bad_footer=%lu, resync=%lu, last_frame_age=%ld ms\n",
                  (unsigned long)(ldBytes / secs), (unsigned long)(ldFrames / secs),
                  (unsigned long)ldBadFooter, (unsigned long)ldResync, ldAge);
    Serial.printf("[diag] RD-6x @%lu baud: %lu B/s, %u distinct byte values, top:",
                  (unsigned long)rdBaud, (unsigned long)(rdBytes / secs), (unsigned)distinct);
    for (int k = 0; k < 4; ++k) if (topB[k] >= 0) Serial.printf(" %02X x%lu", topB[k], (unsigned long)topC[k]);
    Serial.println();
  } else {
    Serial.printf("{\"type\":\"diag\",\"ms\":%lu,\"ld\":{\"bytes_s\":%lu,\"frames_s\":%lu,\"bad_footer\":%lu,"
                  "\"resync\":%lu,\"age_ms\":%ld},\"rd\":{\"baud\":%lu,\"bytes_s\":%lu,\"distinct\":%u,\"top\":[",
                  (unsigned long)now, (unsigned long)(ldBytes / secs), (unsigned long)(ldFrames / secs),
                  (unsigned long)ldBadFooter, (unsigned long)ldResync, ldAge,
                  (unsigned long)rdBaud, (unsigned long)(rdBytes / secs), (unsigned)distinct);
    bool first = true;
    for (int k = 0; k < 4; ++k) {
      if (topB[k] < 0) continue;
      Serial.printf("%s[\"%02X\",%lu]", first ? "" : ",", topB[k], (unsigned long)topC[k]);
      first = false;
    }
    Serial.println("]}}");
  }

  // Ai-Thinker packet framing stats (valid packets prove the baud rate and the framing)
  Serial.printf("{\"type\":\"pkt\",\"ok\":%lu,\"bad_check8\":%lu,\"msg_ids\":[", (unsigned long)pktOk, (unsigned long)pktBad8);
  {
    bool f = true;
    for (int i = 0; i < 8; ++i) {
      if (!pktIdCnt[i]) continue;
      Serial.printf("%s[\"%02X\",%lu]", f ? "" : ",", pktIds[i], (unsigned long)pktIdCnt[i]);
      f = false;
    }
  }
  Serial.println("]}");
  pktOk = 0;
  pktBad8 = 0;
  memset(pktIdCnt, 0, sizeof(pktIdCnt));

  // plain-language hints so you do not have to guess
  if (ldBytes == 0) {
    Serial.println("{\"type\":\"warn\",\"sensor\":\"ld2450\",\"msg\":\"no bytes: check sensor TX->GPIO18, RX->GPIO17, 5V, GND, 256000 baud\"}");
  } else if (ldFrames == 0) {
    Serial.println("{\"type\":\"warn\",\"sensor\":\"ld2450\",\"msg\":\"bytes arrive but no valid frame: wrong baud, noise or different sensor mode (try: cap ld, dump)\"}");
  }
  if (rdBytes == 0) {
    Serial.println("{\"type\":\"warn\",\"sensor\":\"rd6x\",\"msg\":\"no bytes: check data TX->GPIO4, 5V, GND; try rdscan\"}");
  }

  ldBytes = ldFrames = ldBadFooter = ldResync = 0;
  rdBytes = 0;
  memset(rdHist, 0, sizeof(rdHist));
}

// ================= capture / analysis =================
static void startCapture(uint8_t src) {
  if (!capBuf) { Serial.println("{\"type\":\"error\",\"msg\":\"no capture buffer\"}"); return; }
  capLen = 0;
  capDone = false;
  capSrc = src;
  capBaud = (src == 1) ? rdBaud : LD_BAUD;
  Serial.printf("{\"type\":\"info\",\"msg\":\"capturing %u bytes from %s ... (move in front of the sensor now)\"}\n",
                (unsigned)CAP_SIZE, src == 1 ? "rd6x" : "ld2450");
}

static void dumpCapture() {
  if (capLen == 0) { Serial.println("{\"type\":\"error\",\"msg\":\"nothing captured: run 'cap rd' or 'cap ld' first\"}"); return; }
  Serial.printf("{\"type\":\"capture_begin\",\"src\":\"%s\",\"len\":%u,\"baud\":%lu}\n",
                capLastSrc == 1 ? "rd6x" : "ld2450", (unsigned)capLen, (unsigned long)capBaud);
  char line[100];
  for (size_t i = 0; i < capLen; i += 32) {
    const size_t n = min((size_t)32, capLen - i);
    size_t p = 0;
    for (size_t k = 0; k < n; ++k) p += snprintf(line + p, sizeof(line) - p, "%02X", capBuf[i + k]);
    line[p++] = '\n';
    Serial.write((const uint8_t *)line, p);
  }
  Serial.println("{\"type\":\"capture_end\"}");
}

// Find repeating byte patterns (candidate frame headers) and how far apart they are.
static void analyzeCapture(int L) {
  if (capLen < 256) { Serial.println("{\"type\":\"error\",\"msg\":\"capture too small: run 'cap rd' first\"}"); return; }
  if (L < 2) L = 2;
  if (L > 8) L = 8;

  struct Cand { size_t pos; uint16_t count; uint32_t minGap, maxGap; float avg; };
  Cand best[5];
  for (auto &c : best) c = {0, 0, 0, 0, 0};

  const size_t cands = min((size_t)3000, capLen - L);
  for (size_t i = 0; i < cands; ++i) {
    if ((i & 63) == 0) yield();
    const uint8_t *pat = capBuf + i;

    bool allSame = true;
    for (int k = 1; k < L; ++k) if (pat[k] != pat[0]) { allSame = false; break; }
    if (allSame) continue;

    bool seen = false;
    for (size_t j = 0; j < i; ++j) if (memcmp(capBuf + j, pat, L) == 0) { seen = true; break; }
    if (seen) continue;

    uint16_t count = 0;
    long prev = -1;
    size_t firstP = 0, lastP = 0;
    uint32_t mn = 0xFFFFFFFF, mx = 0;
    for (size_t j = 0; j + L <= capLen; ++j) {
      if (capBuf[j] != pat[0]) continue;
      if (memcmp(capBuf + j, pat, L) != 0) continue;
      if (count == 0) firstP = j;
      lastP = j;
      ++count;
      if (prev >= 0) {
        const uint32_t g = (uint32_t)(j - prev);
        if (g < mn) mn = g;
        if (g > mx) mx = g;
      }
      prev = (long)j;
    }
    if (count < 3) continue;

    int slot = -1;
    uint16_t lowest = 0xFFFF;
    for (int s = 0; s < 5; ++s) {
      if (best[s].count < lowest) { lowest = best[s].count; slot = s; }
    }
    if (slot >= 0 && count > best[slot].count) {
      best[slot] = {i, count, mn, mx, (float)(lastP - firstP) / (float)(count - 1)};
    }
  }

  Serial.printf("{\"type\":\"analyze\",\"src\":\"%s\",\"bytes\":%u,\"pattern_len\":%d,\"patterns\":[",
                capLastSrc == 1 ? "rd6x" : "ld2450", (unsigned)capLen, L);
  bool first = true;
  for (int s = 0; s < 5; ++s) {
    if (best[s].count == 0) continue;
    Serial.printf("%s{\"hex\":\"", first ? "" : ",");
    for (int k = 0; k < L; ++k) Serial.printf("%02X", capBuf[best[s].pos + k]);
    Serial.printf("\",\"count\":%u,\"avg_period\":%.1f,\"min_gap\":%lu,\"max_gap\":%lu,\"fixed_frame_len\":%s}",
                  (unsigned)best[s].count, best[s].avg, (unsigned long)best[s].minGap,
                  (unsigned long)best[s].maxGap, (best[s].minGap == best[s].maxGap) ? "true" : "false");
    first = false;
  }
  Serial.println("]}");
  Serial.println("{\"type\":\"info\",\"msg\":\"a real frame header repeats with a steady period (fixed_frame_len=true). try 'analyze 2' or 'analyze 3' if nothing useful\"}");
}

// Try each baud rate for ~0.5 s and score how structured the data looks.
static void rdScan() {
  static const uint32_t bauds[] = {9600, 19200, 38400, 57600, 115200, 230400, 256000, 460800, 921600, 1000000};
  Serial.println("{\"type\":\"info\",\"msg\":\"rdscan: ~6 s, keep the radar powered and move in front of it\"}");
  for (uint32_t b : bauds) {
    RdSerial.end();
    RdSerial.setRxBufferSize(8192);
    RdSerial.begin(b, SERIAL_8N1, RD_RX_PIN, -1);
    delay(50);
    while (RdSerial.available()) RdSerial.read();

    uint32_t hist[256];
    memset(hist, 0, sizeof(hist));
    uint32_t n = 0;
    pktLen = 0;
    pktOk = 0;
    pktBad8 = 0;
    pktQuiet = true;
    const uint32_t t0 = millis();
    while (millis() - t0 < 500) {
      while (RdSerial.available()) {
        const uint8_t rb = (uint8_t)RdSerial.read();
        ++hist[rb];
        ++n;
        pktFeed(rb);
      }
      pumpLd();
    }
    pktQuiet = false;
    const uint32_t scanOk = pktOk, scanBad = pktBad8;

    uint16_t distinct = 0, topB = 0;
    uint32_t topC = 0, ascii = 0, zeros = hist[0];
    float entropy = 0.0f;
    for (int i = 0; i < 256; ++i) {
      if (!hist[i]) continue;
      ++distinct;
      if (hist[i] > topC) { topC = hist[i]; topB = i; }
      if ((i >= 0x20 && i <= 0x7E) || i == 0x0D || i == 0x0A) ascii += hist[i];
      const float p = (float)hist[i] / (float)n;
      entropy -= p * log2f(p);
    }
    if (n == 0) {
      Serial.printf("{\"type\":\"rdscan\",\"baud\":%lu,\"bytes\":0}\n", (unsigned long)b);
    } else {
      Serial.printf("{\"type\":\"rdscan\",\"baud\":%lu,\"bytes\":%lu,\"distinct\":%u,\"entropy_bits\":%.2f,"
                    "\"ascii_pct\":%.0f,\"zero_pct\":%.0f,\"top\":\"%02X\",\"top_pct\":%.0f,"
                    "\"pkt_ok\":%lu,\"pkt_bad_check8\":%lu}\n",
                    (unsigned long)b, (unsigned long)n, (unsigned)distinct, entropy,
                    100.0f * ascii / n, 100.0f * zeros / n, (unsigned)topB, 100.0f * topC / n,
                    (unsigned long)scanOk, (unsigned long)scanBad);
    }
  }
  startRdSerial();
  pktOk = 0;
  pktBad8 = 0;
  pktLen = 0;
  Serial.printf("{\"type\":\"info\",\"msg\":\"rdscan done, back to %lu baud. The right baud shows several valid packets (pkt_ok of 3 or more in 0.5 s; a single 1 can be chance). Wrong baud: pkt_ok 0 or 1\"}\n",
                (unsigned long)rdBaud);
}

// ================= host commands =================
static void sendHexToRadar(const String &args) {
  uint8_t out[64];
  size_t n = 0;
  int i = 0;
  const int len = args.length();
  while (i < len && n < sizeof(out)) {
    while (i < len && args[i] == ' ') ++i;
    if (i >= len) break;
    int j = i;
    while (j < len && args[j] != ' ') ++j;
    out[n++] = (uint8_t)strtoul(args.substring(i, j).c_str(), nullptr, 16);
    i = j;
  }
  RdCmdSerial.write(out, n);
  Serial.printf("{\"type\":\"cmd_sent\",\"bytes\":%u}\n", (unsigned)n);
}

static void printHelp() {
  Serial.println(
      "{\"type\":\"help\",\"commands\":["
      "\"fmt json|text  - output style\","
      "\"status\","
      "\"cap rd | cap ld  - capture 32 KB raw bytes of that sensor\","
      "\"dump  - print the capture as hex (copy it to me)\","
      "\"peek  - show the first 300 captured bytes as text\","
      "\"analyze [2-8]  - find repeating header patterns in the capture\","
      "\"rdscan  - try all baud rates on the RD-6x data pin\","
      "\"rdbaud <n>  - set RD-6x data baud\","
      "\"rdstart  - send the official start sequence (mmwc open ... mmwc start)\","
      "\"rdcmd <text>  - send text + CRLF on the RD-6x command UART (try: rdcmd mmwc)\","
      "\"rdhex <AA BB ..>  - send raw bytes on the RD-6x command UART\"]}");
}

static void handleCommand(String line) {
  line.trim();
  if (line.length() == 0) return;
  String cmd = line, args = "";
  const int sp = line.indexOf(' ');
  if (sp > 0) { cmd = line.substring(0, sp); args = line.substring(sp + 1); args.trim(); }
  cmd.toLowerCase();

  if (cmd == "help") {
    printHelp();
  } else if (cmd == "fmt") {
    args.toLowerCase();
    textMode = (args == "text");
    Serial.printf("{\"type\":\"info\",\"fmt\":\"%s\"}\n", textMode ? "text" : "json");
  } else if (cmd == "status") {
    Serial.printf("{\"type\":\"status\",\"ld_baud\":%lu,\"rd_baud\":%lu,\"rd_rx_pin\":%d,\"cap_len\":%u,\"free_heap\":%u}\n",
                  (unsigned long)LD_BAUD, (unsigned long)rdBaud, RD_RX_PIN, (unsigned)capLen, (unsigned)ESP.getFreeHeap());
  } else if (cmd == "cap") {
    args.toLowerCase();
    if (args == "rd") startCapture(1);
    else if (args == "ld") startCapture(2);
    else Serial.println("{\"type\":\"error\",\"msg\":\"use: cap rd  or  cap ld\"}");
  } else if (cmd == "dump") {
    dumpCapture();
  } else if (cmd == "peek") {
    // first 300 captured bytes as text: shows at once if the stream is ASCII (e.g. "MOTION@7885,432")
    const size_t n = min((size_t)300, capLen);
    Serial.printf("{\"type\":\"peek\",\"len\":%u,\"text\":\"", (unsigned)n);
    printBytesAsText(capBuf, n);
    Serial.println("\"}");
  } else if (cmd == "analyze") {
    analyzeCapture(args.length() ? args.toInt() : 4);
  } else if (cmd == "rdscan") {
    rdScan();
  } else if (cmd == "rdbaud") {
    const long b = args.toInt();
    if (b >= 1200 && b <= 3000000) {
      rdBaud = (uint32_t)b;
      startRdSerial();
      Serial.printf("{\"type\":\"info\",\"rd_baud\":%ld}\n", b);
    } else {
      Serial.println("{\"type\":\"error\",\"msg\":\"use: rdbaud 115200\"}");
    }
  } else if (cmd == "rdstart") {
    seqIdx = 0;
    seqNextMs = millis();
    Serial.println("{\"type\":\"info\",\"msg\":\"sending Ai-Thinker start sequence on the command UART (7 commands)\"}");
  } else if (cmd == "rdcmd") {
    RdCmdSerial.print(args);
    RdCmdSerial.print("\r\n");
    Serial.printf("{\"type\":\"cmd_sent\",\"text\":\"%s\"}\n", args.c_str());
  } else if (cmd == "rdhex") {
    sendHexToRadar(args);
  } else {
    Serial.println("{\"type\":\"error\",\"msg\":\"unknown command, type help\"}");
  }
}

// Print bytes as hex AND as text (the RD-6x command port is a "UART shell", so replies may be ASCII).
static void printBytesAsText(const uint8_t *p, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    const char c = (char)p[i];
    if (c == '"' || c == '\\') { Serial.print('\\'); Serial.print(c); }
    else if (c >= 0x20 && c <= 0x7E) Serial.print(c);
    else if (c == '\n') Serial.print("\\n");
    else if (c == '\r') Serial.print("\\r");
    else Serial.print('.');
  }
}

static void flushCmdReply(uint32_t now) {
  if (cmdReplyLen == 0) return;
  Serial.printf("{\"type\":\"cmd_reply\",\"ms\":%lu,\"len\":%u,\"text\":\"", (unsigned long)now, (unsigned)cmdReplyLen);
  printBytesAsText(cmdReply, cmdReplyLen);
  Serial.print("\",\"hex\":\"");
  for (size_t i = 0; i < cmdReplyLen; ++i)
    Serial.printf("%02X%s", cmdReply[i], (i + 1 < cmdReplyLen) ? " " : "");
  Serial.println("\"}");
  cmdReplyLen = 0;
}

// ================= setup / loop =================
void setup() {
  Serial.begin(USB_BAUD);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  capBuf = (uint8_t *)malloc(CAP_SIZE);

  LdSerial.setRxBufferSize(4096);
  LdSerial.begin(LD_BAUD, SERIAL_8N1, LD_RX_PIN, LD_TX_PIN);

  startRdSerial();

  RdCmdSerial.setRxBufferSize(1024);
  RdCmdSerial.begin(RDC_BAUD, SERIAL_8N1, RDC_RX_PIN, RDC_TX_PIN);

  lastDiagMs = millis();
  Serial.println("{\"type\":\"boot\",\"fw\":\"RoomTraceDebug\",\"hint\":\"type help\"}");
}

void loop() {
  pumpLd();
  pumpRd();

  // host commands
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (hostLine.length()) { handleCommand(hostLine); hostLine = ""; }
    } else if (hostLine.length() < 120) {
      hostLine += c;
    }
  }

  // RD-6x command-port replies (hex, grouped by 15 ms idle gap)
  while (RdCmdSerial.available() > 0) {
    if (cmdReplyLen == sizeof(cmdReply)) flushCmdReply(millis());
    cmdReply[cmdReplyLen++] = (uint8_t)RdCmdSerial.read();
    cmdLastByteMs = millis();
  }
  const uint32_t now = millis();
  if (cmdReplyLen > 0 && now - cmdLastByteMs >= 30) flushCmdReply(now);

  // non-blocking start sequence, one command every 300 ms
  if (seqIdx >= 0 && now >= seqNextMs) {
    RdCmdSerial.print(RD_START_SEQ[seqIdx]);
    RdCmdSerial.print("\r\n");
    Serial.printf("{\"type\":\"cmd_sent\",\"text\":\"%s\"}\n", RD_START_SEQ[seqIdx]);
    seqNextMs = now + 300;
    if (++seqIdx >= RD_START_N) seqIdx = -1;
  }

  if (capDone) {
    capDone = false;
    Serial.printf("{\"type\":\"info\",\"msg\":\"capture complete (%u bytes). run: dump   or   analyze\"}\n", (unsigned)capLen);
  }

  // LD2450 decoded targets
  if (ldNewFrame && now - lastLdPrintMs >= LD_PRINT_MS) {
    ldNewFrame = false;
    lastLdPrintMs = now;
    printLdFrame();
  }

  if (now - lastDiagMs >= DIAG_MS) {
    lastDiagMs = now;
    printDiag(now);
  }
}
