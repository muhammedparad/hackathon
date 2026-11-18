#include "health_monitor.h"
#include "config.h"
#include <stdio.h>

#ifdef ARDUINO
#include <Arduino.h>
#include <esp_task_wdt.h>
#endif

HealthMonitor::HealthMonitor() :
    lastFeedMs(0),
    lastReportMs(0)
{
}

void HealthMonitor::begin() {
#ifdef ARDUINO
    // Initialize Task Watchdog Timer (ESP-IDF v5 / Arduino Core 3.x API)
    esp_task_wdt_config_t twdt_config = {
        .timeout_ms = (uint32_t)(WDT_TIMEOUT_SECONDS * 1000),
        .idle_core_mask = 0,
        .trigger_panic = true
    };
    esp_err_t err = esp_task_wdt_init(&twdt_config);
    if (err == ESP_ERR_INVALID_STATE) {
        esp_task_wdt_reconfigure(&twdt_config);
    }
    esp_task_wdt_add(NULL); // Subscribe current thread
#endif
    feedWatchdog();
}

void HealthMonitor::feedWatchdog() {
#ifdef ARDUINO
    esp_task_wdt_reset();
#endif
}

uint32_t HealthMonitor::getFreeHeap() const {
#ifdef ARDUINO
    return ESP.getFreeHeap();
#else
    return 196608;
#endif
}

uint32_t HealthMonitor::getFreePsram() const {
#ifdef ARDUINO
    return ESP.getFreePsram();
#else
    return 8388608;
#endif
}

void HealthMonitor::reportDiagnostics(
    uint32_t nowMs,
    uint32_t ldFrames,
    uint32_t ldErrors,
    uint32_t rdPackets
) {
    if (nowMs - lastReportMs >= 10000) { // Every 10 seconds
        lastReportMs = nowMs;
#ifdef ARDUINO
        Serial.printf(
            "[DIAG] Up: %lu s | Heap: %lu B | PSRAM: %lu B | LD2450 Frames: %lu (Err: %lu) | RD-61 Pkts: %lu\n",
            nowMs / 1000,
            getFreeHeap(),
            getFreePsram(),
            ldFrames,
            ldErrors,
            rdPackets
        );
#else
        (void)ldFrames;
        (void)ldErrors;
        (void)rdPackets;
#endif
    }
}
