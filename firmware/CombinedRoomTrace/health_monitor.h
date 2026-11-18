#pragma once

#include <stdint.h>
#include <stdbool.h>

class HealthMonitor {
private:
    uint32_t lastFeedMs;
    uint32_t lastReportMs;

public:
    HealthMonitor();

    void begin();
    void feedWatchdog();
    void reportDiagnostics(uint32_t nowMs, uint32_t ldFrames, uint32_t ldErrors, uint32_t rdPackets);
    uint32_t getFreeHeap() const;
    uint32_t getFreePsram() const;
};
