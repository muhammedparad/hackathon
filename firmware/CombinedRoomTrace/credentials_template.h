#pragma once

/**
 * RoomTrace ESP32-S3 Firmware — Credentials Template
 *
 * INSTRUCTIONS:
 * 1. Copy this file to "credentials.h":
 *    cp credentials_template.h credentials.h
 * 2. Populate your local Wi-Fi SSID, Password, and RoomTrace Device Credentials.
 * 3. NEVER commit "credentials.h" or production secrets to Git!
 */

// Local 2.4 GHz Wi-Fi Network Credentials (ESP32-S3 does not support 5 GHz Wi-Fi)
#define WIFI_SSID     "YOUR_WIFI_SSID_HERE"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD_HERE"

// RoomTrace Ingestion Backend API URL (HTTPS recommended in production)
#define ROOMTRACE_API_URL "http://192.168.1.100:8080" // or "https://roomtrace.yourdomain.com"

// Device Credentials generated from RoomTrace Dashboard > Devices > Register Device
// The secret key is hashed with SHA-256 server-side. Firebase Admin secrets NEVER exist on the ESP32!
#define ROOMTRACE_DEVICE_ID  "your-device-id"
#define ROOMTRACE_DEVICE_KEY "your-device-secret"
