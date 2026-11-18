#include "telemetry.h"
#include <stdio.h>
#include <string.h>

size_t TelemetrySerializer::serializeLD2450(
    const LD2450FrameData& frame,
    const char* isoTimestamp,
    bool isTimeSynced,
    char* outJson,
    size_t maxLen
) {
    if (!outJson || maxLen < 128) return 0;

    int written = 0;
    if (isoTimestamp && strlen(isoTimestamp) > 0) {
        written = snprintf(outJson, maxLen,
            "{\"timestamp\":\"%s\",\"device_time_synced\":%s,\"captured_at_ms\":%lu,\"data\":{\"sensor_type\":\"ld2450\",\"targets\":[",
            isoTimestamp,
            isTimeSynced ? "true" : "false",
            (unsigned long)frame.timestamp_ms
        );
    } else {
        written = snprintf(outJson, maxLen,
            "{\"device_time_synced\":false,\"captured_at_ms\":%lu,\"data\":{\"sensor_type\":\"ld2450\",\"targets\":[",
            (unsigned long)frame.timestamp_ms
        );
    }

    if (written < 0 || (size_t)written >= maxLen) return 0;

    bool first = true;
    for (uint8_t i = 0; i < 3; i++) {
        if (!frame.targets[i].is_active) continue;

        char targetBuf[128];
        int tLen = snprintf(targetBuf, sizeof(targetBuf),
            "%s{\"target_id\":%u,\"x_mm\":%d,\"y_mm\":%d,\"speed_cms\":%d}",
            first ? "" : ",",
            frame.targets[i].target_id,
            frame.targets[i].x_mm,
            frame.targets[i].y_mm,
            frame.targets[i].speed_cms
        );

        first = false;
        if (tLen > 0 && (size_t)(written + tLen + 8) < maxLen) {
            strcat(outJson, targetBuf);
            written += tLen;
        }
    }

    int closing = snprintf(outJson + written, maxLen - written, "]}}");
    if (closing < 0 || (size_t)(written + closing) >= maxLen) return 0;

    return written + closing;
}

size_t TelemetrySerializer::serializeHeartbeat(
    const char* fwVersion,
    const char* ipAddress,
    int rssi,
    uint32_t freeHeap,
    bool sensorConnected,
    char* outJson,
    size_t maxLen
) {
    if (!outJson || maxLen < 160) return 0;

    int written = snprintf(outJson, maxLen,
        "{\"firmware_version\":\"%s\",\"ip_address\":\"%s\",\"rssi\":%d,\"free_heap\":%u,\"sensor_status\":\"%s\",\"ld2450_connected\":%s}",
        fwVersion,
        ipAddress,
        rssi,
        freeHeap,
        sensorConnected ? "online" : "disconnected",
        sensorConnected ? "true" : "false"
    );

    if (written < 0 || (size_t)written >= maxLen) return 0;
    return (size_t)written;
}
