#include "http_client.h"
#include <stdio.h>
#include <string.h>

#ifdef ARDUINO
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#endif

RoomTraceHttpClient::RoomTraceHttpClient(const char* baseUrl, const char* initialDeviceId, const char* initialDeviceKey) :
    baseUrl(baseUrl),
    authStatus(AUTH_STATUS_OK),
    lastAuthFailureMs(0),
    authBackoffMs(0),
    authFailureCount(0)
{
    updateCredentials(initialDeviceId, initialDeviceKey);
}

void RoomTraceHttpClient::updateCredentials(const char* newDeviceId, const char* newDeviceKey) {
    if (newDeviceId) {
        strncpy(deviceId, newDeviceId, sizeof(deviceId) - 1);
        deviceId[sizeof(deviceId) - 1] = '\0';
    }
    if (newDeviceKey) {
        strncpy(deviceKey, newDeviceKey, sizeof(deviceKey) - 1);
        deviceKey[sizeof(deviceKey) - 1] = '\0';
    }
    // Reset authentication backoff upon credential update
    authStatus = AUTH_STATUS_OK;
    authFailureCount = 0;
    authBackoffMs = 0;
}

bool RoomTraceHttpClient::canAttemptTransmission(uint32_t nowMs) const {
    if (authStatus == AUTH_STATUS_OK) {
        return true;
    }
    // If in auth backoff, only allow transmission after backoff interval has elapsed
    if (nowMs - lastAuthFailureMs >= authBackoffMs) {
        return true;
    }
    return false;
}

void RoomTraceHttpClient::noteResponseStatus(int httpCode, uint32_t nowMs) {
    if (httpCode >= 200 && httpCode < 300) {
        authStatus = AUTH_STATUS_OK;
        authFailureCount = 0;
        authBackoffMs = 0;
    } else if (httpCode == HTTP_RES_UNAUTHORIZED) {
        authStatus = AUTH_STATUS_REJECTED_401;
        authFailureCount++;
        // Bounded exponential backoff: 10s, 20s, 40s, max 60s
        authBackoffMs = (authFailureCount > 3) ? 60000 : (10000 * (1 << (authFailureCount - 1)));
        lastAuthFailureMs = nowMs;
    } else if (httpCode == HTTP_RES_FORBIDDEN) {
        authStatus = AUTH_STATUS_FORBIDDEN_403;
        authFailureCount++;
        authBackoffMs = (authFailureCount > 3) ? 60000 : (10000 * (1 << (authFailureCount - 1)));
        lastAuthFailureMs = nowMs;
    }
}

HttpResult RoomTraceHttpClient::sendTelemetry(const char* jsonPayload) {
#ifdef ARDUINO
    HTTPClient http;
    char url[256];
    snprintf(url, sizeof(url), "%s/api/public/device/telemetry", baseUrl);

    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Id", deviceId);
    http.addHeader("X-Device-Key", deviceKey);
    http.setTimeout(2500); // 2.5s network timeout

    int httpCode = http.POST((uint8_t*)jsonPayload, strlen(jsonPayload));
    http.end();

    if (httpCode > 0) {
        return (HttpResult)httpCode;
    }
    return HTTP_RES_NETWORK_ERROR;
#else
    (void)jsonPayload;
    return HTTP_RES_OK;
#endif
}

HttpResult RoomTraceHttpClient::sendHeartbeat(const char* jsonPayload) {
#ifdef ARDUINO
    HTTPClient http;
    char url[256];
    snprintf(url, sizeof(url), "%s/api/public/device/heartbeat", baseUrl);

    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Id", deviceId);
    http.addHeader("X-Device-Key", deviceKey);
    http.setTimeout(3000);

    int httpCode = http.POST((uint8_t*)jsonPayload, strlen(jsonPayload));
    http.end();

    if (httpCode > 0) {
        return (HttpResult)httpCode;
    }
    return HTTP_RES_NETWORK_ERROR;
#else
    (void)jsonPayload;
    return HTTP_RES_OK;
#endif
}
