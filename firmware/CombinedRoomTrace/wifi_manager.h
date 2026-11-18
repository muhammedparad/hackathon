#pragma once

#include <stdint.h>
#include <stdbool.h>

enum WifiState {
    WIFI_STATE_DISCONNECTED,
    WIFI_STATE_CONNECTING,
    WIFI_STATE_CONNECTED,
    WIFI_STATE_BACKOFF
};

class WifiManager {
private:
    const char* ssid;
    const char* password;
    WifiState state;
    uint32_t lastStateChangeMs;
    uint32_t currentBackoffMs;
    uint32_t reconnectAttempts;

public:
    WifiManager(const char* ssid, const char* password);

    void begin();
    void update(uint32_t nowMs);
    bool isConnected() const;
    WifiState getState() const;
    const char* getLocalIp() const;
    int getRssi() const;
};
