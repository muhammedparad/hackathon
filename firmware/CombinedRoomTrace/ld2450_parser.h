#pragma once

#include <stdint.h>
#include <stdbool.h>

#define LD2450_FRAME_LEN 30

struct LD2450TargetData {
    uint8_t target_id;       // 1..3
    int16_t x_mm;            // Lateral position relative to sensor normal
    int16_t y_mm;            // Radial distance from sensor
    int16_t speed_cms;       // Radial velocity (cm/s)
    uint16_t resolution_mm;  // Distance resolution gate
    bool is_active;          // True if target is currently detected
};

struct LD2450FrameData {
    uint32_t timestamp_ms;
    uint8_t target_count;
    LD2450TargetData targets[3];
};

class LD2450Parser {
private:
    uint8_t rxBuffer[LD2450_FRAME_LEN];
    uint8_t bufferIndex;
    
public:
    uint32_t bytesProcessed;
    uint32_t framesParsed;
    uint32_t framingErrors;
    uint32_t headerResyncs;

    LD2450Parser();

    /**
     * Decodes an HLK-LD2450 16-bit sign-and-magnitude value into signed int16.
     * Bit 15 = sign (1 = negative, 0 = positive)
     * Bits 0..14 = magnitude
     */
    static int16_t decodeSignMagnitude(uint16_t raw);

    /**
     * Non-blocking byte-by-byte stream parser.
     * Synchronizes to 0xAA 0xFF 0x03 0x00 and 0x55 0xCC footer.
     * Returns true when a complete valid 30-byte frame has been assembled.
     */
    bool feedByte(uint8_t byte, LD2450FrameData& outFrame);

    /** Resets the internal framing state */
    void reset();
};
