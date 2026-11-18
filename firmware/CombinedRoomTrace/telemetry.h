#pragma once

#include "ld2450_parser.h"
#include <stddef.h>

/**
 * Normalizes LD2450 radar targets into RoomTrace JSON payload format.
 * Serializes into pre-allocated static buffer to avoid heap fragmentation.
 */
class TelemetrySerializer {
public:
    static size_t serializeLD2450(
        const LD2450FrameData& frame,
        const char* isoTimestamp,
        bool isTimeSynced,
        char* outJson,
        size_t maxLen
    );

    static size_t serializeHeartbeat(
        const char* fwVersion,
        const char* ipAddress,
        int rssi,
        uint32_t freeHeap,
        bool sensorConnected,
        char* outJson,
        size_t maxLen
    );
};
