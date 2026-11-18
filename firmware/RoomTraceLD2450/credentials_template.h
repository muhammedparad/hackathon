// Copy this file to credentials.h (same folder) and fill it in.
// credentials.h is git-ignored: never commit real Wi-Fi passwords or device keys.
#pragma once

// 2.4 GHz Wi-Fi only (ESP32 does not support 5 GHz)
#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"

// Your Render service host, no https:// and no path. Example: roomtrace.onrender.com
#define ROOMTRACE_SERVER_HOST "your-service.onrender.com"
#define ROOMTRACE_SERVER_PORT 443

// Create the device on the website (Devices page). The key is shown ONCE when you register it.
#define ROOMTRACE_DEVICE_ID "your-device-id"
#define ROOMTRACE_DEVICE_KEY "your-device-secret"

// 1 = skip TLS certificate checking (first tests only; the device key could be read by an attacker
// on the same network). Set to 0 once a CA certificate is added (see README).
#define ROOMTRACE_TLS_INSECURE 1
