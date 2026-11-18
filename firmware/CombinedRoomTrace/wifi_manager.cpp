#include "wifi_manager.h"
#include "config.h"

#ifdef ARDUINO
#include <WiFi.h>
#else
// Mock / Standalone compilation stub for testing
static char mockIp[] = "192.168.1.150";
#endif

WifiManager::WifiManager(const char* ssid, const char* password) :
    ssid(ssid),
    password(password),
    state(WIFI_STATE_DISCONNECTED),
    lastStateChangeMs(0),
    currentBackoffMs(WIFI_RETRY_MIN_MS),
    reconnectAttempts(0)
{
}

void WifiManager::begin() {
#ifdef ARDUINO
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
#endif
    state = WIFI_STATE_CONNECTING;
    lastStateChangeMs = 0;
}

void WifiManager::update(uint32_t nowMs) {
#ifdef ARDUINO
    wl_status_t status = WiFi.status();

    switch (state) {
        case WIFI_STATE_DISCONNECTED:
            state = WIFI_STATE_CONNECTING;
            lastStateChangeMs = nowMs;
            WiFi.disconnect();
            WiFi.begin(ssid, password);
            break;

        case WIFI_STATE_CONNECTING:
            if (status == WL_CONNECTED) {
                state = WIFI_STATE_CONNECTED;
                currentBackoffMs = WIFI_RETRY_MIN_MS;
                reconnectAttempts = 0;
                lastStateChangeMs = nowMs;
            } else if (nowMs - lastStateChangeMs > 10000) { // 10s connection timeout
                state = WIFI_STATE_BACKOFF;
                lastStateChangeMs = nowMs;
                reconnectAttempts++;
            }
            break;

        case WIFI_STATE_CONNECTED:
            if (status != WL_CONNECTED) {
                state = WIFI_STATE_BACKOFF;
                lastStateChangeMs = nowMs;
                currentBackoffMs = WIFI_RETRY_MIN_MS;
            }
            break;

        case WIFI_STATE_BACKOFF:
            if (nowMs - lastStateChangeMs >= currentBackoffMs) {
                state = WIFI_STATE_CONNECTING;
                lastStateChangeMs = nowMs;
                WiFi.disconnect();
                WiFi.begin(ssid, password);

                // Exponential backoff with ceiling
                currentBackoffMs = currentBackoffMs * 2;
                if (currentBackoffMs > WIFI_RETRY_MAX_MS) {
                    currentBackoffMs = WIFI_RETRY_MAX_MS;
                }
            }
            break;
    }
#else
    // Desktop / simulation environment: immediately simulate connected
    (void)nowMs;
    state = WIFI_STATE_CONNECTED;
#endif
}

bool WifiManager::isConnected() const {
    return state == WIFI_STATE_CONNECTED;
}

WifiState WifiManager::getState() const {
    return state;
}

const char* WifiManager::getLocalIp() const {
#ifdef ARDUINO
    static char ipBuf[24];
    IPAddress ip = WiFi.localIP();
    snprintf(ipBuf, sizeof(ipBuf), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
    return ipBuf;
#else
    return mockIp;
#endif
}

int WifiManager::getRssi() const {
#ifdef ARDUINO
    return WiFi.RSSI();
#else
    return -62;
#endif
}
