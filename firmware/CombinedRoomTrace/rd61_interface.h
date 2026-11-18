#pragma once

#include <stdint.h>
#include <stdbool.h>

/**
 * Ai-Thinker RD-61 60 GHz Radar Raw Interface
 * Target Firmware: #2967 Standard Point Cloud V1.0.0
 *
 * NOTE: The UART protocol for RD-61 firmware #2967 is unverified.
 * This interface performs raw byte accumulation and buffering.
 * Speculative point cloud conversion or physiological decoding is strictly suppressed.
 */

#define RD61_RAW_BUF_SIZE 1024

struct RD61RawFrame {
    uint32_t timestamp_ms;
    uint16_t byte_length;
    uint8_t bytes[RD61_RAW_BUF_SIZE];
};

class RD61Interface {
private:
    uint8_t buffer[RD61_RAW_BUF_SIZE];
    uint16_t currentLength;
    uint32_t lastByteTime;

public:
    uint32_t bytesReceived;
    uint32_t packetsCaptured;

    RD61Interface();

    /** Ingests a raw byte from UART2 */
    void feedByte(uint8_t byte);

    /** Checks if a packet boundary has been reached by inter-byte timeout (> 10ms idle) */
    bool checkPacketTimeout(uint32_t nowMs, RD61RawFrame& outFrame);

    /** Resets the buffer */
    void reset();
};
