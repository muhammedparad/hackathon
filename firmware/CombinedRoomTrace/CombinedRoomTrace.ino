/**
 * RoomTrace — ESP32-S3 Combined Firmware (Phase 5.1.3 Queue Concurrency & Recovery)
 *
 * Architecture:
 * - Dual-Core FreeRTOS Partitioning:
 *   * Core 1: High-Speed Sensor Polling (LD2450 UART1 256k baud, RD-61 UART2 921.6k baud)
 *   * Core 0: Network Stack (Wi-Fi, HTTP Client, Heartbeat, Watchdog, Diagnostics)
 * - Zero Dynamic Allocation in Streaming Hot Path (Static Buffers)
 * - Hardware Watchdog Enabled (8-second timeout)
 * - Monotonic Ring-Buffer with In-Flight Frame Immutability Protection
 */

#include "config.h"

// Check for user credentials, else fall back to template
#if __has_include("credentials.h")
#include "credentials.h"
#else
#include "credentials_template.h"
#endif

#include "ld2450_parser.h"
#include "rd61_interface.h"
#include "telemetry.h"
#include "wifi_manager.h"
#include "http_client.h"
#include "health_monitor.h"

#ifdef ARDUINO
#include <Arduino.h>
#include <HardwareSerial.h>

HardwareSerial SerialLD(1); // UART1 for HLK-LD2450
HardwareSerial SerialRD(2); // UART2 for Ai-Thinker RD-61
#endif

// Static Parsers & Subsystems
static LD2450Parser ldParser;
static RD61Interface rdInterface;
static WifiManager wifiMgr(WIFI_SSID, WIFI_PASSWORD);
static RoomTraceHttpClient httpClient(ROOMTRACE_API_URL, ROOMTRACE_DEVICE_ID, ROOMTRACE_DEVICE_KEY);
static HealthMonitor health;

// Inter-Core Ring Buffer with Monotonic Sequence Counters
static LD2450FrameData ringBuffer[RING_BUFFER_CAPACITY];
static volatile uint32_t ringHeadSeq = 0;   // Monotonic index for enqueued frames
static volatile uint32_t ringTailSeq = 0;   // Monotonic index for dequeued/dropped frames
static volatile uint32_t ringDropCount = 0; // Cumulative frames dropped due to buffer overflow
static portMUX_TYPE ringMux = portMUX_INITIALIZER_UNLOCKED;

// Dedicated Immutable Transmission Buffer (Task 1: In-Flight Immutability)
struct InFlightTransmission {
    LD2450FrameData frame;
    uint32_t sequence;       // Exact monotonic sequence number staged
    uint32_t capturedAtMs;   // Frame capture timestamp (millis)
    bool isTimeSynced;       // Whether device clock was calibrated at capture
    char isoTimestamp[32];   // ISO 8601 UTC timestamp string
    bool active;             // Whether an in-flight frame is staged for transmission
    uint8_t retryCount;      // Number of retries attempted
};
static InFlightTransmission inFlight = {};

// Static string buffers for zero-allocation telemetry
static char telemetryJson[TELEMETRY_PAYLOAD_BUFFER_SIZE];
static char heartbeatJson[256];
static char isoTimeBuffer[32];

// Sensor Health & Connection State
static volatile bool ld2450Connected = false;
static volatile uint32_t lastLd2450RxMs = 0;

// Task Handles
TaskHandle_t sensorTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;

/**
 * Core 1 Sensor Task: Dedicated high-priority UART ingestion
 */
void sensorTask(void* parameter) {
    (void)parameter;
#ifdef ARDUINO
    SerialLD.begin(LD2450_BAUD_RATE, SERIAL_8N1, PIN_LD2450_RX, PIN_LD2450_TX);
    SerialRD.begin(RD61_BAUD_RATE, SERIAL_8N1, PIN_RD61_RX, PIN_RD61_TX);
#endif

    LD2450FrameData parsedFrame;
    RD61RawFrame rawRdFrame;

    for (;;) {
#ifdef ARDUINO
        // 1. Ingest LD2450 256k baud stream
        while (SerialLD.available() > 0) {
            uint8_t b = SerialLD.read();
            lastLd2450RxMs = millis();
            if (ldParser.feedByte(b, parsedFrame)) {
                ld2450Connected = true;
                parsedFrame.timestamp_ms = millis();

                portENTER_CRITICAL(&ringMux);
                // If ring buffer is full, drop oldest frame by advancing monotonic tail
                if ((ringHeadSeq - ringTailSeq) >= RING_BUFFER_CAPACITY) {
                    ringTailSeq++;
                    ringDropCount++;
                }
                ringBuffer[ringHeadSeq % RING_BUFFER_CAPACITY] = parsedFrame;
                ringHeadSeq++;
                portEXIT_CRITICAL(&ringMux);
            }
        }

        // Check for sensor silence timeout (> 2.5s)
        uint32_t nowSensorMs = millis();
        if (nowSensorMs - lastLd2450RxMs > SENSOR_STALE_TIMEOUT_MS) {
            ld2450Connected = false;
            // CRITICAL: A silent/disconnected sensor NEVER pushes fake empty frames!
        }

        // 2. Ingest RD-61 921.6k baud stream (Raw Capture Only - Unverified Protocol)
        while (SerialRD.available() > 0) {
            uint8_t b = SerialRD.read();
            rdInterface.feedByte(b);
        }

        if (rdInterface.checkPacketTimeout(nowSensorMs, rawRdFrame)) {
            // Raw RD-61 burst captured: preserved in diagnostics, suppressed from alerts
        }
#endif
        // Yield 1ms to prevent starving background RTOS watchdog
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

/**
 * Network Subsystem Step: Executed on Core 0
 */
void networkStep(uint32_t nowMs) {
    // 1. Update Wi-Fi State Machine
    wifiMgr.update(nowMs);

    // 2. Status LED Indicator
#ifdef ARDUINO
    if (wifiMgr.isConnected()) {
        digitalWrite(PIN_STATUS_LED, HIGH);
    } else {
        digitalWrite(PIN_STATUS_LED, (nowMs / 500) % 2); // Blink when disconnected
    }
#endif

    // 3. Transmit Queued LD2450 Telemetry (Rate Paced to 10 Hz)
    static uint32_t lastTelemetryMs = 0;
    static uint32_t transientBackoffMs = 0;

    if (wifiMgr.isConnected() && (nowMs - lastTelemetryMs >= TELEMETRY_INTERVAL_MS)) {
        // Task 2: Check if authentication backoff allows transmission
        if (httpClient.canAttemptTransmission(nowMs)) {
            // Task 1: Stage frame into immutable inFlight transmission buffer inside short critical section
            portENTER_CRITICAL(&ringMux);
            if (!inFlight.active && (ringHeadSeq > ringTailSeq)) {
                uint32_t tailIdx = ringTailSeq % RING_BUFFER_CAPACITY;
                inFlight.frame = ringBuffer[tailIdx];
                inFlight.sequence = ringTailSeq;
                inFlight.capturedAtMs = inFlight.frame.timestamp_ms;
                inFlight.isTimeSynced = false;
                inFlight.isoTimestamp[0] = '\0';
                inFlight.active = true;
                inFlight.retryCount = 0;
            }
            portEXIT_CRITICAL(&ringMux);

            // Transmit outside critical section (no spinlocks held during network I/O)
            if (inFlight.active) {
                lastTelemetryMs = nowMs;

                size_t len = TelemetrySerializer::serializeLD2450(
                    inFlight.frame,
                    inFlight.isoTimestamp,
                    inFlight.isTimeSynced,
                    telemetryJson,
                    sizeof(telemetryJson)
                );

                if (len > 0) {
                    HttpResult res = httpClient.sendTelemetry(telemetryJson);
                    httpClient.noteResponseStatus((int)res, nowMs);
                    HttpDisposition disp = classifyHttpResponse((int)res);

                    switch (disp) {
                        case DISPOSITION_SUCCESS:
                            portENTER_CRITICAL(&ringMux);
                            // Safe monotonic queue advancement:
                            // If queue tail sequence matches inFlight.sequence, dequeue it!
                            if (ringTailSeq == inFlight.sequence) {
                                ringTailSeq++;
                            }
                            // If ringTailSeq > inFlight.sequence, producer overflowed during transmission
                            // and already advanced ringTailSeq. Do NOT double-advance!
                            inFlight.active = false;
                            portEXIT_CRITICAL(&ringMux);
                            transientBackoffMs = 0;
                            break;

                        case DISPOSITION_DISCARD_PERMANENT:
                            portENTER_CRITICAL(&ringMux);
                            // Unprocessable frame (HTTP 400/404/422): discard immediately to unblock queue!
                            if (ringTailSeq == inFlight.sequence) {
                                ringTailSeq++;
                            }
                            inFlight.active = false;
                            portEXIT_CRITICAL(&ringMux);
                            transientBackoffMs = 0;
#ifdef ARDUINO
                            Serial.printf("[HTTP] Permanent error %d for frame seq %lu. Discarded to unblock queue.\n",
                                (int)res, (unsigned long)inFlight.sequence);
#endif
                            break;

                        case DISPOSITION_AUTH_FAILURE:
                            // HTTP 401/403: Credentials rejected.
                            // Release inFlight so we do not hold a stale frame forever.
                            // The frame remains in ringBuffer unless evicted by producer overflow.
                            portENTER_CRITICAL(&ringMux);
                            inFlight.active = false;
                            portEXIT_CRITICAL(&ringMux);
#ifdef ARDUINO
                            Serial.printf("[AUTH] Authentication rejected (HTTP %d). Telemetry suspended for Device %s.\n",
                                (int)res, httpClient.getDeviceId());
#endif
                            break;

                        case DISPOSITION_RETRY_RATELIMIT:
                            // HTTP 429: Rate limited.
                            portENTER_CRITICAL(&ringMux);
                            if (ringTailSeq != inFlight.sequence) {
                                // Producer overflowed and evicted this frame; abort retry of evicted frame
                                inFlight.active = false;
                            } else {
                                inFlight.retryCount++;
                            }
                            portEXIT_CRITICAL(&ringMux);
                            lastTelemetryMs = nowMs + 1500; // Back off 1.5s
                            break;

                        case DISPOSITION_RETRY_CONFLICT:
                            // HTTP 409: State conflict.
                            portENTER_CRITICAL(&ringMux);
                            if (ringTailSeq != inFlight.sequence) {
                                inFlight.active = false;
                            } else {
                                inFlight.retryCount++;
                            }
                            portEXIT_CRITICAL(&ringMux);
                            lastTelemetryMs = nowMs + 1000;
                            break;

                        case DISPOSITION_RETRY_TRANSIENT:
                        default:
                            portENTER_CRITICAL(&ringMux);
                            if (ringTailSeq != inFlight.sequence) {
                                // Buffer overflowed while waiting; frame already evicted
                                inFlight.active = false;
                            } else {
                                inFlight.retryCount++;
                            }
                            portEXIT_CRITICAL(&ringMux);
                            transientBackoffMs = (transientBackoffMs == 0) ? 1000 :
                                ((transientBackoffMs * 2 > 10000) ? 10000 : transientBackoffMs * 2);
                            lastTelemetryMs = nowMs + transientBackoffMs;
                            break;
                    }
                }
            }
        }
    }

    // 4. Send Periodic Heartbeat (Every 15s) with Explicit Sensor Health
    static uint32_t lastHeartbeatMs = 0;
    if (wifiMgr.isConnected() && (nowMs - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS)) {
        lastHeartbeatMs = nowMs;

        size_t hbLen = TelemetrySerializer::serializeHeartbeat(
            ROOMTRACE_FW_VERSION,
            wifiMgr.getLocalIp(),
            wifiMgr.getRssi(),
            health.getFreeHeap(),
            ld2450Connected,
            heartbeatJson,
            sizeof(heartbeatJson)
        );

        if (hbLen > 0) {
            httpClient.sendHeartbeat(heartbeatJson);
        }
    }

    // 5. Diagnostics Reporting (Every 10s)
    health.reportDiagnostics(
        nowMs,
        ldParser.framesParsed,
        ldParser.framingErrors,
        rdInterface.packetsCaptured
    );
}

/**
 * Core 0 Network Worker Task
 */
void networkWorkerTask(void* parameter) {
    (void)parameter;
    for (;;) {
#ifdef ARDUINO
        uint32_t nowMs = millis();
        networkStep(nowMs);
#endif
        vTaskDelay(pdMS_TO_TICKS(5));
    }
}

void setup() {
#ifdef ARDUINO
    Serial.begin(115200);
    delay(100);
    Serial.println("\n=======================================================");
    Serial.println("RoomTrace ESP32-S3 Controller — Firmware v" ROOMTRACE_FW_VERSION);
    Serial.println("Device ID: " ROOMTRACE_DEVICE_ID);
    Serial.println("=======================================================");

    pinMode(PIN_STATUS_LED, OUTPUT);
    digitalWrite(PIN_STATUS_LED, LOW);

    // Initialize Watchdog & Health Subsystem
    health.begin();

    // Start Wi-Fi Subsystem
    wifiMgr.begin();

    // Pin Sensor Ingestion Task to Core 1
    xTaskCreatePinnedToCore(
        sensorTask,
        "SensorIngestTask",
        4096,
        NULL,
        2, // High priority for serial ingestion
        &sensorTaskHandle,
        1  // Run on Core 1
    );

    // Pin Network Worker Task to Core 0
    xTaskCreatePinnedToCore(
        networkWorkerTask,
        "NetworkWorkerTask",
        8192,
        NULL,
        1, // Normal priority for networking
        &networkTaskHandle,
        0  // Run on Core 0 alongside Wi-Fi stack
    );
#endif
}

void loop() {
    // Service Watchdog on Core 1
    health.feedWatchdog();
#ifdef ARDUINO
    vTaskDelay(pdMS_TO_TICKS(100));
#endif
}
