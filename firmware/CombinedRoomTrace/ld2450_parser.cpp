#include "ld2450_parser.h"

LD2450Parser::LD2450Parser() :
    bufferIndex(0),
    bytesProcessed(0),
    framesParsed(0),
    framingErrors(0),
    headerResyncs(0)
{
}

int16_t LD2450Parser::decodeSignMagnitude(uint16_t raw) {
    bool isNegative = (raw & 0x8000) != 0;
    int16_t magnitude = (int16_t)(raw & 0x7FFF);
    return isNegative ? -magnitude : magnitude;
}

void LD2450Parser::reset() {
    bufferIndex = 0;
}

bool LD2450Parser::feedByte(uint8_t byte, LD2450FrameData& outFrame) {
    bytesProcessed++;

    // Header synchronization state machine (0xAA 0xFF 0x03 0x00)
    if (bufferIndex == 0) {
        if (byte == 0xAA) {
            rxBuffer[0] = byte;
            bufferIndex = 1;
        }
        return false;
    }
    if (bufferIndex == 1) {
        if (byte == 0xFF) {
            rxBuffer[1] = byte;
            bufferIndex = 2;
        } else {
            bufferIndex = (byte == 0xAA) ? 1 : 0;
            headerResyncs++;
        }
        return false;
    }
    if (bufferIndex == 2) {
        if (byte == 0x03) {
            rxBuffer[2] = byte;
            bufferIndex = 3;
        } else {
            bufferIndex = 0;
            headerResyncs++;
        }
        return false;
    }
    if (bufferIndex == 3) {
        if (byte == 0x00) {
            rxBuffer[3] = byte;
            bufferIndex = 4;
        } else {
            bufferIndex = 0;
            headerResyncs++;
        }
        return false;
    }

    // Accumulate payload and footer (bytes 4..29)
    rxBuffer[bufferIndex++] = byte;

    if (bufferIndex == LD2450_FRAME_LEN) {
        bufferIndex = 0; // Prepare for next frame

        // Validate footer: 0x55 0xCC
        if (rxBuffer[28] != 0x55 || rxBuffer[29] != 0xCC) {
            framingErrors++;
            headerResyncs++;
            return false;
        }

        // Frame verified! Decode 3 targets
        framesParsed++;
        outFrame.target_count = 0;

        for (uint8_t i = 0; i < 3; i++) {
            uint8_t offset = 4 + (i * 8);

            uint16_t rawX = (uint16_t)(rxBuffer[offset] | (rxBuffer[offset + 1] << 8));
            uint16_t rawY = (uint16_t)(rxBuffer[offset + 2] | (rxBuffer[offset + 3] << 8));
            uint16_t rawSpeed = (uint16_t)(rxBuffer[offset + 4] | (rxBuffer[offset + 5] << 8));
            uint16_t rawRes = (uint16_t)(rxBuffer[offset + 6] | (rxBuffer[offset + 7] << 8));

            int16_t x_mm = decodeSignMagnitude(rawX);
            int16_t y_mm = decodeSignMagnitude(rawY);
            int16_t speed_cms = decodeSignMagnitude(rawSpeed);

            bool isActive = (y_mm != 0 || x_mm != 0 || rawRes > 0);

            outFrame.targets[i].target_id = i + 1;
            outFrame.targets[i].x_mm = x_mm;
            outFrame.targets[i].y_mm = y_mm;
            outFrame.targets[i].speed_cms = speed_cms;
            outFrame.targets[i].resolution_mm = rawRes;
            outFrame.targets[i].is_active = isActive;

            if (isActive) {
                outFrame.target_count++;
            }
        }

        return true;
    }

    return false;
}
