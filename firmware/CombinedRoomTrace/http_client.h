#pragma once

#include <stdint.h>
#include <stdbool.h>

enum HttpResult {
    HTTP_RES_OK = 200,
    HTTP_RES_BAD_REQUEST = 400,
    HTTP_RES_UNAUTHORIZED = 401,
    HTTP_RES_FORBIDDEN = 403,
    HTTP_RES_NOT_FOUND = 404,
    HTTP_RES_CONFLICT = 409,
    HTTP_RES_UNPROCESSABLE = 422,
    HTTP_RES_RATE_LIMITED = 429,
    HTTP_RES_SERVER_ERROR = 500,
    HTTP_RES_TIMEOUT = -2,
    HTTP_RES_NETWORK_ERROR = -1
};

/**
 * Explicit classification for HTTP responses to control queue dequeue and retry policies
 */
enum HttpDisposition {
    DISPOSITION_SUCCESS,          // 200..299: Dequeue frame immediately
    DISPOSITION_RETRY_TRANSIENT,  // Network error (-1), Timeout (-2), 5xx: Retain frame, back off (1s..10s)
    DISPOSITION_RETRY_RATELIMIT,  // 429: Retain frame, back off 1s..2s
    DISPOSITION_RETRY_CONFLICT,   // 409: Conflict (e.g. sequence collision or state race), backoff 1s
    DISPOSITION_AUTH_FAILURE,     // 401/403: Retain frame, extended backoff (10s..60s), do NOT flood
    DISPOSITION_DISCARD_PERMANENT // 400/404/422/other 4xx: Discard corrupt/unrouteable frame to unblock queue!
};

enum AuthStatus {
    AUTH_STATUS_OK,               // Validated credentials; transmissions active
    AUTH_STATUS_REJECTED_401,     // Invalid device ID or device secret key
    AUTH_STATUS_FORBIDDEN_403,    // Device revoked, unauthorized room, or disabled
    AUTH_STATUS_SUSPENDED         // Extended backoff active
};

/** Helper to classify an HTTP response code into an actionable queue disposition */
inline HttpDisposition classifyHttpResponse(int httpCode) {
    if (httpCode >= 200 && httpCode < 300) {
        return DISPOSITION_SUCCESS;
    }
    if (httpCode == HTTP_RES_UNAUTHORIZED || httpCode == HTTP_RES_FORBIDDEN) {
        return DISPOSITION_AUTH_FAILURE;
    }
    if (httpCode == HTTP_RES_RATE_LIMITED) {
        return DISPOSITION_RETRY_RATELIMIT;
    }
    if (httpCode == HTTP_RES_CONFLICT) {
        return DISPOSITION_RETRY_CONFLICT;
    }
    if (httpCode == HTTP_RES_BAD_REQUEST || 
        httpCode == HTTP_RES_UNPROCESSABLE || 
        httpCode == HTTP_RES_NOT_FOUND || 
        (httpCode >= 400 && httpCode < 500)) {
        return DISPOSITION_DISCARD_PERMANENT;
    }
    // Network errors (-1), timeouts (-2), and server errors (5xx) are transient
    return DISPOSITION_RETRY_TRANSIENT;
}

class RoomTraceHttpClient {
private:
    const char* baseUrl;
    char deviceId[64];
    char deviceKey[128];
    AuthStatus authStatus;
    uint32_t lastAuthFailureMs;
    uint32_t authBackoffMs;
    uint8_t authFailureCount;

public:
    RoomTraceHttpClient(const char* baseUrl, const char* initialDeviceId, const char* initialDeviceKey);

    /** Update device credentials at runtime (e.g. upon recovery or remote provisioning) */
    void updateCredentials(const char* newDeviceId, const char* newDeviceKey);

    /** Returns current device ID */
    const char* getDeviceId() const { return deviceId; }

    /** Returns authentication health status */
    AuthStatus getAuthStatus() const { return authStatus; }

    /** Whether telemetry transmissions are currently permitted (false during auth backoff) */
    bool canAttemptTransmission(uint32_t nowMs) const;

    /** Records authentication status from HTTP code */
    void noteResponseStatus(int httpCode, uint32_t nowMs);

    /** Transmits a JSON telemetry payload to /api/public/device/telemetry */
    HttpResult sendTelemetry(const char* jsonPayload);

    /** Transmits a JSON heartbeat payload to /api/public/device/heartbeat */
    HttpResult sendHeartbeat(const char* jsonPayload);
};
