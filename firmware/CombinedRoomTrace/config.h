#pragma once

/**
 * RoomTrace ESP32-S3 Firmware — Hardware & System Configuration
 *
 * Microcontroller: ESP32-S3-WROOM-1 (N16R8)
 * Primary Radar: Hi-Link HLK-LD2450 (24 GHz) on UART1 (256,000 baud)
 * Secondary Radar: Ai-Thinker RD-61 (60 GHz) on UART2 (921,600 baud, unverified raw capture)
 */

#define ROOMTRACE_FW_VERSION "1.0.0-phase5"

// ---------------- Authoritative Provisional GPIO Mappings (ESP32-S3) ----------------
// PROVISIONAL: Subject to physical bench verification with DMM before wiring.
// 5V supply required for radars; ESP32-S3 GPIOs are strictly 3.3V CMOS.
#ifndef PIN_LD2450_RX
#define PIN_LD2450_RX 18   // ESP32 UART1 RX (Input)  <-- HLK-LD2450 TX (Provisional)
#define PIN_LD2450_TX 17   // ESP32 UART1 TX (Output) --> HLK-LD2450 RX (Provisional)
#endif
#define PIN_ESP32_RX1_LD2450 PIN_LD2450_RX
#define PIN_ESP32_TX1_LD2450 PIN_LD2450_TX

#ifndef PIN_RD61_RX
#define PIN_RD61_RX   8    // ESP32 UART2 RX (Input)  <-- RD-60-Kit TX (Provisional)
#define PIN_RD61_TX   9    // ESP32 UART2 TX (Output) --> RD-60-Kit RX (Provisional)
#endif
#define PIN_ESP32_RX2_RD61 PIN_RD61_RX
#define PIN_ESP32_TX2_RD61 PIN_RD61_TX

#ifndef PIN_SD_CS
#define PIN_SD_CS     10   // Future MicroSD FSPI Chip Select (Provisional)
#define PIN_SD_MOSI   11   // Future MicroSD FSPI MOSI (Provisional)
#define PIN_SD_SCK    12   // Future MicroSD FSPI SCK (Provisional)
#define PIN_SD_MISO   13   // Future MicroSD FSPI MISO (Provisional)
#endif

#ifndef PIN_STATUS_LED
#define PIN_STATUS_LED 21  // Status LED for Wi-Fi / sensor status (Provisional)
#endif

// ---------------- UART Communication Parameters ----------------
#ifndef LD2450_BAUD_RATE
#define LD2450_BAUD_RATE 256000
#endif

#ifndef RD61_BAUD_RATE
// PROVISIONAL: High-speed baud rate for Firmware #2967. Subject to logic analyzer confirmation.
#define RD61_BAUD_RATE   921600
#endif

// ---------------- Timing & Telemetry Intervals ----------------
#define TELEMETRY_INTERVAL_MS 100    // 10 Hz telemetry streaming
#define HEARTBEAT_INTERVAL_MS 15000  // 15 s keep-alive heartbeat
#define SENSOR_STALE_TIMEOUT_MS 2500 // Mark sensor disconnected if silent > 2.5s

// ---------------- Network & Watchdog Settings ----------------
#define WIFI_RETRY_MIN_MS 2000
#define WIFI_RETRY_MAX_MS 60000
#define WDT_TIMEOUT_SECONDS 8        // Hardware Watchdog timeout (seconds)

// ---------------- Buffer Capacities (Zero Dynamic Allocation) ----------------
#define UART_RX_BUFFER_SIZE 512
#define TELEMETRY_PAYLOAD_BUFFER_SIZE 1024
#define RING_BUFFER_CAPACITY 50      // Holds up to 50 historical LD2450 frames in RAM
