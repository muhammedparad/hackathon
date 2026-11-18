#include "rd61_interface.h"

RD61Interface::RD61Interface() :
    currentLength(0),
    lastByteTime(0),
    bytesReceived(0),
    packetsCaptured(0)
{
}

void RD61Interface::feedByte(uint8_t byte) {
    bytesReceived++;
    if (currentLength < RD61_RAW_BUF_SIZE) {
        buffer[currentLength++] = byte;
    }
}

bool RD61Interface::checkPacketTimeout(uint32_t nowMs, RD61RawFrame& outFrame) {
    if (currentLength == 0) return false;

    // If more than 10ms has elapsed since the last byte, treat as packet burst boundary
    if (nowMs - lastByteTime > 10 && currentLength >= 8) {
        outFrame.timestamp_ms = nowMs;
        outFrame.byte_length = currentLength;
        for (uint16_t i = 0; i < currentLength; i++) {
            outFrame.bytes[i] = buffer[i];
        }
        packetsCaptured++;
        currentLength = 0;
        return true;
    }

    lastByteTime = nowMs;
    return false;
}

void RD61Interface::reset() {
    currentLength = 0;
}
