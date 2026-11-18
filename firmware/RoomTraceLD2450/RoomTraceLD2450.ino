/*
  RoomTrace LD2450 firmware (ESP32-S3)  -  real data only

  LD2450 (UART1, GPIO18 RX / GPIO17 TX, 256000 baud)  ->  decoded targets (x, y, speed)
  ESP32 -> Wi-Fi -> RoomTrace server on Render, two ways, chosen automatically:
    1. WebSocket (wss://<host>/device-ws): one connection kept open, authenticated once, then every frame is
       a small message (no TLS handshake or HTTP headers per frame). Fast: frames can go out ~6x per second.
    2. HTTPS POST fallback, used whenever the socket is not ready (and for the first seconds after boot):
         POST /api/public/device/telemetry   (up to 2 per second while someone is in view)
         POST /api/public/device/heartbeat   (every 15 s)
  Auth: device id + key (register the device on the website first): X-Device-Id / X-Device-Key headers for
  HTTPS, one {"type":"auth"} message for the WebSocket.

  Setup: copy credentials_template.h to credentials.h and fill it in.
  Arduino IDE: board "ESP32S3 Dev Module", USB CDC On Boot = Enabled, Serial Monitor 115200 baud.
  Library needed for the WebSocket: "WebSockets" by Markus Sattler (Library Manager, v2.4 or newer).
  Without it, set ROOMTRACE_USE_WS 0 in credentials.h and everything works over HTTPS as before.
  (WiFi, WiFiClientSecure, HTTPClient ship with the ESP32 core.)

  What is NOT in here on purpose: RD-6x, breathing/heart rate, any made-up data. If the LD2450 is
  silent, nothing is sent as telemetry and the heartbeat reports the sensor as disconnected.
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include <sys/time.h>
#include <math.h>

#if __has_include("credentials.h")
#include "credentials.h"
#else
#error "Missing credentials.h: copy credentials_template.h to credentials.h and fill it in."
#endif

// WebSocket to the server (set to 0 in credentials.h to use HTTPS POST only).
#ifndef ROOMTRACE_USE_WS
#define ROOMTRACE_USE_WS 1
#endif
#ifndef ROOMTRACE_WS_PATH
#define ROOMTRACE_WS_PATH "/device-ws"
#endif

#if ROOMTRACE_USE_WS
#include <WebSocketsClient.h>
#endif

static const char *FW_VERSION = "ld2450-1.0.0";

// ---------------- pins / timing ----------------
static constexpr int      LD_RX_PIN = 18;
static constexpr int      LD_TX_PIN = 17;
static constexpr uint32_t LD_BAUD   = 256000;

// The server currently stores every post in Firestore (free tier: ~20k writes/day), so keep these
// gentle until the server downsamples history. Lower SEND_INTERVAL_MS (e.g. 200) for smoother live view.
static constexpr uint32_t SEND_INTERVAL_MS   = 500;    // HTTPS fallback: max 2 telemetry posts/s while targets present
// Over the WebSocket the server shows every frame live but stores history at most about once a second
// (and at once when the number of targets changes), so a fast send rate does not cost database writes.
static constexpr uint32_t WS_SEND_INTERVAL_MS = 150;   // ~6 frames/s while targets present
static constexpr uint32_t WS_RECONNECT_MS     = 5000;
static constexpr uint32_t EMPTY_INTERVAL_MS  = 10000;  // empty-room posts, so the server sees "still empty"
static constexpr uint32_t HEARTBEAT_MS       = 15000;
static constexpr uint32_t SENSOR_TIMEOUT_MS  = 3000;   // no LD2450 frame for this long -> sensor offline
static constexpr uint32_t WIFI_RETRY_MS      = 8000;
static constexpr uint32_t STATUS_MS          = 5000;
static constexpr uint32_t HTTP_TIMEOUT_MS    = 3000;
static constexpr time_t   MIN_VALID_EPOCH    = 1704067200;  // 2024-01-01: anything earlier = clock not synced

HardwareSerial LdSerial(1);

// ---------------- LD2450 parser ----------------
struct LdTarget {
  bool on = false;
  int16_t x = 0, y = 0, v = 0;
  uint16_t res = 0;
};

static const uint8_t LD_HDR[4] = {0xAA, 0xFF, 0x03, 0x00};
static uint8_t  ldBuf[30];
static size_t   ldIdx = 0;
static LdTarget ldT[3];
static uint32_t ldLastFrameMs = 0;
static bool     ldNewFrame = false;
static uint32_t ldFrames = 0, ldBadFooter = 0;       // since last status line
static uint32_t ldFramesTotal = 0;

static int16_t decodeSigned(const uint8_t *p) {
  const uint16_t raw = (uint16_t)p[0] | ((uint16_t)p[1] << 8);
  const int16_t mag = (int16_t)(raw & 0x7FFF);
  return (raw & 0x8000) ? mag : -mag;  // bit15 = 1 -> positive (LD2450 datasheet)
}

static void ldDecode() {
  for (uint8_t i = 0; i < 3; ++i) {
    const uint8_t *p = &ldBuf[4 + i * 8];
    LdTarget &t = ldT[i];
    t.x = decodeSigned(p);
    t.y = decodeSigned(p + 2);
    t.v = decodeSigned(p + 4);
    t.res = (uint16_t)p[6] | ((uint16_t)p[7] << 8);
    t.on = !(t.x == 0 && t.y == 0 && t.v == 0 && t.res == 0);
  }
  ldLastFrameMs = millis();
  ldNewFrame = true;
  ++ldFrames;
  ++ldFramesTotal;
}

static void ldFeed(uint8_t b);

static void ldRecover() {
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
  while (LdSerial.available() > 0) ldFeed((uint8_t)LdSerial.read());
}

// A target is only reported if it is physically valid for the server schema (y >= 0, sane ranges).
static bool targetReportable(const LdTarget &t) {
  return t.on && t.y >= 0 && t.x >= -20000 && t.x <= 20000 && t.y <= 20000 && t.v >= -1000 && t.v <= 1000;
}

static uint8_t reportableCount() {
  uint8_t n = 0;
  for (uint8_t i = 0; i < 3; ++i) if (targetReportable(ldT[i])) ++n;
  return n;
}

static bool sensorOnline(uint32_t now) {
  return ldLastFrameMs != 0 && (now - ldLastFrameMs) <= SENSOR_TIMEOUT_MS;
}

// ---------------- Wi-Fi / time ----------------
static uint32_t lastWifiTryMs = 0;
static bool     wifiWasUp = false;
static bool     ntpStarted = false;

static bool timeSynced() { return time(nullptr) >= MIN_VALID_EPOCH; }

// Millisecond precision on purpose: the server drops a frame whose timestamp equals the previous one,
// so second-resolution timestamps would silently discard most frames at 2+ posts per second.
static bool isoNow(char *out, size_t cap) {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  if (tv.tv_sec < MIN_VALID_EPOCH) return false;
  const time_t s = tv.tv_sec;
  struct tm tmv;
  gmtime_r(&s, &tmv);
  const size_t n = strftime(out, cap, "%Y-%m-%dT%H:%M:%S", &tmv);
  snprintf(out + n, cap - n, ".%03dZ", (int)(tv.tv_usec / 1000));
  return true;
}

static void maintainWifi(uint32_t now) {
  const bool up = (WiFi.status() == WL_CONNECTED);
  if (up && !wifiWasUp) {
    Serial.printf("{\"type\":\"wifi\",\"status\":\"connected\",\"ip\":\"%s\",\"rssi\":%d}\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    if (!ntpStarted) {
      configTime(0, 0, "pool.ntp.org", "time.google.com");
      ntpStarted = true;
    }
  }
  if (!up && wifiWasUp) Serial.println("{\"type\":\"wifi\",\"status\":\"lost\"}");
  wifiWasUp = up;

  if (!up && now - lastWifiTryMs >= WIFI_RETRY_MS) {
    lastWifiTryMs = now;
    Serial.printf("{\"type\":\"wifi\",\"status\":\"connecting\",\"code\":%d}\n", (int)WiFi.status());
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// ---------------- HTTPS ----------------
static WiFiClientSecure secureClient;
static HTTPClient http;
static String baseUrl;

static uint32_t postsOk = 0, postsFail = 0, postsDropped = 0;
static uint32_t postMsSum = 0, postMsMax = 0, postMsCount = 0;  // round-trip time of each POST (ms)
static int      lastHttpCode = 0;

static int postJson(const char *path, const char *body) {
  if (WiFi.status() != WL_CONNECTED) { ++postsDropped; return -1000; }
  const String url = baseUrl + path;
  if (!http.begin(secureClient, url)) { ++postsFail; return -1001; }
  http.setReuse(true);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", ROOMTRACE_DEVICE_ID);
  http.addHeader("X-Device-Key", ROOMTRACE_DEVICE_KEY);
  const uint32_t postStart = millis();
  const int code = http.POST((uint8_t *)body, strlen(body));
  const uint32_t postMs = millis() - postStart;
  postMsSum += postMs;
  if (postMs > postMsMax) postMsMax = postMs;
  ++postMsCount;
  http.end();
  lastHttpCode = code;
  if (code >= 200 && code < 300) {
    ++postsOk;
  } else {
    ++postsFail;
    Serial.printf("{\"type\":\"http_error\",\"path\":\"%s\",\"code\":%d,\"hint\":\"%s\"}\n", path, code,
                  (code == 401 || code == 403) ? "check ROOMTRACE_DEVICE_ID / KEY (register the device on the website)"
                  : (code == 400)              ? "server rejected the payload"
                  : (code == 429)              ? "sending too fast"
                  : (code < 0)                 ? "network/TLS error or server asleep"
                                               : "server error");
  }
  return code;
}

// ---------------- WebSocket (fast path) ----------------
// wsReady is true only after the server answered our auth message with {"type":"ready"}.
// While it is false, every send goes through postJson() above, so a socket problem never silences the device.
static bool     wsReady = false;
static bool     wsStarted = false;
static uint32_t wsSent = 0, wsConnects = 0, wsDrops = 0, httpFallbacks = 0;

#if ROOMTRACE_USE_WS
static WebSocketsClient ws;

static void wsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      char auth[200];
      snprintf(auth, sizeof(auth), "{\"type\":\"auth\",\"device_id\":\"%s\",\"key\":\"%s\"}",
               ROOMTRACE_DEVICE_ID, ROOMTRACE_DEVICE_KEY);
      ws.sendTXT(auth);
      ++wsConnects;
      Serial.println("{\"type\":\"ws\",\"status\":\"connected\",\"msg\":\"authenticating\"}");
      break;
    }
    case WStype_TEXT: {
      char msg[160];
      const size_t n = length < sizeof(msg) - 1 ? length : sizeof(msg) - 1;
      memcpy(msg, payload, n);
      msg[n] = 0;
      if (strstr(msg, "\"type\":\"ready\"")) {
        wsReady = true;
        Serial.println("{\"type\":\"ws\",\"status\":\"ready\"}");
      } else if (strstr(msg, "\"type\":\"error\"")) {
        Serial.printf("{\"type\":\"ws_error\",\"server\":%s,\"hint\":\"%s\"}\n", msg,
                      strstr(msg, "unauthorized") ? "check ROOMTRACE_DEVICE_ID / KEY" : "see server message");
      }  // acks and pongs need no handling
      break;
    }
    case WStype_DISCONNECTED:
      if (wsReady || wsConnects) ++wsDrops;
      wsReady = false;
      Serial.println("{\"type\":\"ws\",\"status\":\"disconnected\",\"msg\":\"using HTTPS until it is back\"}");
      break;
    default:
      break;
  }
}

static void wsStart() {
  if (wsStarted) return;
  wsStarted = true;
#if ROOMTRACE_TLS_INSECURE
  ws.beginSSL(ROOMTRACE_SERVER_HOST, ROOMTRACE_SERVER_PORT, ROOMTRACE_WS_PATH);  // no CA given: certificate not checked
#else
  ws.beginSslWithCA(ROOMTRACE_SERVER_HOST, ROOMTRACE_SERVER_PORT, ROOMTRACE_WS_PATH, ROOMTRACE_CA_CERT);
#endif
  ws.onEvent(wsEvent);
  ws.setReconnectInterval(WS_RECONNECT_MS);
  ws.enableHeartbeat(15000, 3000, 2);  // ping every 15 s; drop the connection after 2 missed pongs
}
#endif

/** Sends `body` (a JSON object) as a WebSocket message of the given type. False means: use HTTPS instead. */
static bool wsPost(const char *type, const char *body) {
#if ROOMTRACE_USE_WS
  if (!wsReady || body[0] != '{') return false;
  char msg[720];
  const int n = snprintf(msg, sizeof(msg), "{\"type\":\"%s\",%s", type, body + 1);
  if (n <= 0 || (size_t)n >= sizeof(msg)) return false;
  if (!ws.sendTXT((uint8_t *)msg, (size_t)n)) return false;
  ++wsSent;
  return true;
#else
  (void)type; (void)body;
  return false;
#endif
}

static void deliver(const char *type, const char *path, const char *body) {
  if (wsPost(type, body)) return;
  ++httpFallbacks;
  postJson(path, body);
}

static bool fastPath() { return wsReady; }

static uint32_t lastSendMs = 0;
static uint8_t  lastSentCount = 0;
static uint32_t lastHeartbeatMs = 0;

static void sendTelemetry(uint32_t now) {
  char body[640];
  char ts[32];
  int n = 0;
  if (isoNow(ts, sizeof(ts)))
    n += snprintf(body + n, sizeof(body) - n, "{\"timestamp\":\"%s\",\"device_time_synced\":true,", ts);
  else
    n += snprintf(body + n, sizeof(body) - n, "{\"device_time_synced\":false,");
  n += snprintf(body + n, sizeof(body) - n,
                "\"captured_at_ms\":%lu,\"data\":{\"sensor_type\":\"ld2450\",\"sensor_status\":\"online\",\"targets\":[",
                (unsigned long)now);
  bool first = true;
  uint8_t count = 0;
  for (uint8_t i = 0; i < 3; ++i) {
    const LdTarget &t = ldT[i];
    if (!targetReportable(t)) continue;
    n += snprintf(body + n, sizeof(body) - n, "%s{\"target_id\":%u,\"x_mm\":%d,\"y_mm\":%d,\"speed_cms\":%d}",
                  first ? "" : ",", (unsigned)(i + 1), (int)t.x, (int)t.y, (int)t.v);
    first = false;
    ++count;
  }
  n += snprintf(body + n, sizeof(body) - n, "]}}");
  if (n <= 0 || (size_t)n >= sizeof(body)) { Serial.println("{\"type\":\"error\",\"msg\":\"telemetry body too long\"}"); return; }

  deliver("telemetry", "/api/public/device/telemetry", body);
  lastSendMs = now;
  lastSentCount = count;
}

static void sendHeartbeat(uint32_t now) {
  const bool online = sensorOnline(now);
  char body[320];
  snprintf(body, sizeof(body),
           "{\"firmware_version\":\"%s\",\"ip_address\":\"%s\",\"rssi\":%d,\"free_heap\":%u,"
           "\"sensor_status\":\"%s\",\"ld2450_connected\":%s}",
           FW_VERSION, WiFi.localIP().toString().c_str(), WiFi.RSSI(), (unsigned)ESP.getFreeHeap(),
           online ? "online" : "disconnected", online ? "true" : "false");
  deliver("heartbeat", "/api/public/device/heartbeat", body);
  lastHeartbeatMs = now;
}

// ---------------- status output ----------------
static uint32_t lastStatusMs = 0;

static void printStatus(uint32_t now) {
  const float secs = STATUS_MS / 1000.0f;
  Serial.printf(
      "{\"type\":\"status\",\"ms\":%lu,\"wifi\":%s,\"rssi\":%d,\"time_synced\":%s,\"ld_online\":%s,"
      "\"ld_fps\":%.1f,\"ld_bad_footer\":%lu,\"targets\":%u,\"post_ok\":%lu,\"post_fail\":%lu,"
      "\"post_dropped\":%lu,\"last_http\":%d,\"post_ms_avg\":%lu,\"post_ms_max\":%lu,"
      "\"ws_ready\":%s,\"ws_sent\":%lu,\"ws_drops\":%lu,\"http_fallbacks\":%lu}\n",
      (unsigned long)now, WiFi.status() == WL_CONNECTED ? "true" : "false", WiFi.RSSI(),
      timeSynced() ? "true" : "false", sensorOnline(now) ? "true" : "false", ldFrames / secs,
      (unsigned long)ldBadFooter, (unsigned)reportableCount(), (unsigned long)postsOk,
      (unsigned long)postsFail, (unsigned long)postsDropped, lastHttpCode,
      (unsigned long)(postMsCount ? postMsSum / postMsCount : 0), (unsigned long)postMsMax,
      wsReady ? "true" : "false", (unsigned long)wsSent, (unsigned long)wsDrops,
      (unsigned long)httpFallbacks);
  if (!sensorOnline(now))
    Serial.println("{\"type\":\"warn\",\"msg\":\"no LD2450 frames: check TX->GPIO18, RX->GPIO17, 5V, GND\"}");
  ldFrames = 0;
  ldBadFooter = 0;
  postMsSum = postMsMax = postMsCount = 0;
}

// ---------------- setup / loop ----------------
void setup() {
  Serial.begin(115200);
  const uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) delay(10);

  LdSerial.setRxBufferSize(4096);
  LdSerial.begin(LD_BAUD, SERIAL_8N1, LD_RX_PIN, LD_TX_PIN);

#if ROOMTRACE_TLS_INSECURE
  secureClient.setInsecure();
  Serial.println("{\"type\":\"warn\",\"msg\":\"TLS certificate checking is OFF (ROOMTRACE_TLS_INSECURE=1): test only\"}");
#else
  secureClient.setCACert(ROOMTRACE_CA_CERT);  // define ROOMTRACE_CA_CERT (PEM) in credentials.h, see README
#endif

  baseUrl = String("https://") + ROOMTRACE_SERVER_HOST;
  if (ROOMTRACE_SERVER_PORT != 443) baseUrl += String(":") + String(ROOMTRACE_SERVER_PORT);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep can add 100-300 ms of latency to every request
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiTryMs = millis();

  Serial.printf("{\"type\":\"boot\",\"fw\":\"%s\",\"device\":\"%s\",\"server\":\"%s\"}\n", FW_VERSION,
                ROOMTRACE_DEVICE_ID, baseUrl.c_str());
}

void loop() {
  pumpLd();
  const uint32_t now = millis();

  maintainWifi(now);

#if ROOMTRACE_USE_WS
  if (WiFi.status() == WL_CONNECTED) {
    wsStart();  // begins once, after Wi-Fi is up; the library then reconnects by itself
    ws.loop();
  }
#endif

  const bool online = sensorOnline(now);
  const uint8_t count = reportableCount();

  if (WiFi.status() == WL_CONNECTED && online) {
    const uint32_t interval = fastPath() ? WS_SEND_INTERVAL_MS : SEND_INTERVAL_MS;
    const bool targetsDue = count > 0 && ldNewFrame && (now - lastSendMs >= interval);
    const bool justEmptied = count == 0 && lastSentCount > 0;
    const bool emptyDue = count == 0 && (now - lastSendMs >= EMPTY_INTERVAL_MS);
    if (targetsDue || justEmptied || emptyDue) {
      ldNewFrame = false;
      sendTelemetry(now);
    }
  }

  if (WiFi.status() == WL_CONNECTED && (lastHeartbeatMs == 0 || now - lastHeartbeatMs >= HEARTBEAT_MS)) {
    sendHeartbeat(now);
  }

  if (now - lastStatusMs >= STATUS_MS) {
    lastStatusMs = now;
    printStatus(now);
  }
}
