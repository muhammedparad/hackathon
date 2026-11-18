/**
 * RoomTrace — HLK-LD2450 Radar UART Protocol Parser
 *
 * Implements the official Hi-Link HLK-LD2450 24 GHz tracking radar binary UART framing.
 *
 * UART Specifications:
 * - Baud rate: 256,000 baud
 * - Data bits: 8
 * - Stop bits: 1
 * - Parity: None (8N1)
 *
 * Protocol Structure (Standard 30-Byte Report Frame):
 * - Header (4 bytes):  0xAA 0xFF 0x03 0x00
 * - Target 1 (8 bytes): X (2B), Y (2B), Speed (2B), Distance Resolution (2B)
 * - Target 2 (8 bytes): X (2B), Y (2B), Speed (2B), Distance Resolution (2B)
 * - Target 3 (8 bytes): X (2B), Y (2B), Speed (2B), Distance Resolution (2B)
 * - Footer (2 bytes):  0x55 0xCC
 *
 * Coordinate & Velocity Encoding:
 * - 16-bit little-endian words.
 * - Sign-and-magnitude format:
 *   * Bit 15 (0x8000): Sign (1 = negative, 0 = positive)
 *   * Bits 0..14 (0x7FFF): Magnitude
 */

import type { LD2450Target } from "./types";

export const LD2450_FRAME_LENGTH = 30;
export const LD2450_HEADER = new Uint8Array([0xaa, 0xff, 0x03, 0x00]);
export const LD2450_FOOTER = new Uint8Array([0x55, 0xcc]);

export interface LD2450RawTarget {
  target_id: number;
  x_mm: number;
  y_mm: number;
  speed_cms: number;
  resolution_mm: number;
  is_active: boolean;
}

export interface LD2450ParsedFrame {
  timestamp: number;
  targets: LD2450Target[];
  rawTargets: LD2450RawTarget[];
}

export interface ParserStats {
  bytesProcessed: number;
  framesParsed: number;
  framingErrors: number;
  headerResyncs: number;
  bufferOverflows: number;
}

/** Decodes a 16-bit sign-and-magnitude word from LD2450 into a signed integer */
export function decodeSignMagnitude(word: number): number {
  const isNegative = (word & 0x8000) !== 0;
  const magnitude = word & 0x7fff;
  return isNegative ? -magnitude : magnitude;
}

/** Encodes a signed integer into a 16-bit sign-and-magnitude word for LD2450 */
export function encodeSignMagnitude(val: number): number {
  const clamped = Math.max(-0x7fff, Math.min(0x7fff, Math.round(val)));
  if (clamped < 0) {
    return 0x8000 | Math.abs(clamped);
  }
  return clamped & 0x7fff;
}

/**
 * Parses a single complete 30-byte buffer into an LD2450 frame.
 * Returns null if the buffer is malformed or invalid.
 */
export function parseLD2450Frame(
  buffer: Uint8Array | number[],
  timestamp = Date.now(),
): LD2450ParsedFrame | null {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (data.length < LD2450_FRAME_LENGTH) return null;

  // Validate 4-byte header
  if (data[0] !== 0xaa || data[1] !== 0xff || data[2] !== 0x03 || data[3] !== 0x00) {
    return null;
  }

  // Validate 2-byte footer
  if (data[28] !== 0x55 || data[29] !== 0xcc) {
    return null;
  }

  const rawTargets: LD2450RawTarget[] = [];
  const activeTargets: LD2450Target[] = [];

  for (let i = 0; i < 3; i++) {
    const offset = 4 + i * 8;
    const rawX = data[offset]! | (data[offset + 1]! << 8);
    const rawY = data[offset + 2]! | (data[offset + 3]! << 8);
    const rawSpeed = data[offset + 4]! | (data[offset + 5]! << 8);
    const rawRes = data[offset + 6]! | (data[offset + 7]! << 8);

    const x_mm = decodeSignMagnitude(rawX);
    const y_mm = decodeSignMagnitude(rawY);
    const speed_cms = decodeSignMagnitude(rawSpeed);
    const resolution_mm = rawRes;

    // Slot is active if distance is non-zero
    const is_active = y_mm !== 0 || x_mm !== 0 || resolution_mm > 0;

    const rawT: LD2450RawTarget = {
      target_id: i + 1,
      x_mm,
      y_mm,
      speed_cms,
      resolution_mm,
      is_active,
    };
    rawTargets.push(rawT);

    if (is_active) {
      activeTargets.push({
        target_id: i + 1,
        x_mm,
        y_mm,
        speed_cms,
      });
    }
  }

  return {
    timestamp,
    targets: activeTargets,
    rawTargets,
  };
}

/**
 * Serializes target data into a valid 30-byte binary LD2450 frame.
 * Useful for deterministic testing, unit test fixtures, and desktop emulation.
 */
export function serializeLD2450Frame(
  targets: Array<{
    target_id: number;
    x_mm: number;
    y_mm: number;
    speed_cms: number;
    resolution_mm?: number;
  }>,
): Uint8Array {
  const buf = new Uint8Array(LD2450_FRAME_LENGTH);

  // Header 0xAA 0xFF 0x03 0x00
  buf[0] = 0xaa;
  buf[1] = 0xff;
  buf[2] = 0x03;
  buf[3] = 0x00;

  for (const t of targets) {
    if (t.target_id < 1 || t.target_id > 3) continue;
    const slotIndex = t.target_id - 1;
    const offset = 4 + slotIndex * 8;

    const encX = encodeSignMagnitude(t.x_mm);
    const encY = encodeSignMagnitude(t.y_mm);
    const encSpeed = encodeSignMagnitude(t.speed_cms);
    const encRes = (t.resolution_mm ?? 100) & 0xffff;

    buf[offset] = encX & 0xff;
    buf[offset + 1] = (encX >> 8) & 0xff;

    buf[offset + 2] = encY & 0xff;
    buf[offset + 3] = (encY >> 8) & 0xff;

    buf[offset + 4] = encSpeed & 0xff;
    buf[offset + 5] = (encSpeed >> 8) & 0xff;

    buf[offset + 6] = encRes & 0xff;
    buf[offset + 7] = (encRes >> 8) & 0xff;
  }

  // Footer 0x55 0xCC
  buf[28] = 0x55;
  buf[29] = 0xcc;

  return buf;
}

/**
 * Non-blocking continuous stream parser with ring-buffer synchronization.
 * Handles fragmented chunks, UART noise, partial frames, and resynchronization.
 */
export class LD2450StreamParser {
  private buffer: Uint8Array;
  private writePos = 0;
  private readonly maxBufferSize: number;

  public stats: ParserStats = {
    bytesProcessed: 0,
    framesParsed: 0,
    framingErrors: 0,
    headerResyncs: 0,
    bufferOverflows: 0,
  };

  constructor(maxBufferSize = 1024) {
    this.maxBufferSize = maxBufferSize;
    this.buffer = new Uint8Array(maxBufferSize);
  }

  /**
   * Appends incoming raw bytes (from UART or network packet) and extracts all valid frames.
   */
  public pushChunk(chunk: Uint8Array | number[], timestamp = Date.now()): LD2450ParsedFrame[] {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const frames: LD2450ParsedFrame[] = [];

    // Overflow protection: if incoming bytes exceed remaining buffer, slide or reset
    if (this.writePos + bytes.length > this.maxBufferSize) {
      this.stats.bufferOverflows++;
      this.writePos = 0; // Drop buffer on overflow
    }

    this.buffer.set(bytes, this.writePos);
    this.writePos += bytes.length;
    this.stats.bytesProcessed += bytes.length;

    let readPos = 0;

    while (this.writePos - readPos >= LD2450_FRAME_LENGTH) {
      // Find frame header: 0xAA 0xFF 0x03 0x00
      if (
        this.buffer[readPos] === 0xaa &&
        this.buffer[readPos + 1] === 0xff &&
        this.buffer[readPos + 2] === 0x03 &&
        this.buffer[readPos + 3] === 0x00
      ) {
        // Validate footer at candidate frame end
        const footerIndex = readPos + LD2450_FRAME_LENGTH - 2;
        if (this.buffer[footerIndex] === 0x55 && this.buffer[footerIndex + 1] === 0xcc) {
          const candidate = this.buffer.subarray(readPos, readPos + LD2450_FRAME_LENGTH);
          const parsed = parseLD2450Frame(candidate, timestamp);
          if (parsed) {
            frames.push(parsed);
            this.stats.framesParsed++;
            readPos += LD2450_FRAME_LENGTH;
            continue;
          }
        } else {
          // Framing error: header matched but footer did not
          this.stats.framingErrors++;
          this.stats.headerResyncs++;
          readPos++;
          continue;
        }
      }

      // Slide forward searching for header
      readPos++;
    }

    // Retain any remaining unparsed trailing bytes
    const remaining = this.writePos - readPos;
    if (remaining > 0) {
      this.buffer.copyWithin(0, readPos, this.writePos);
      this.writePos = remaining;
    } else {
      this.writePos = 0;
    }

    return frames;
  }

  /** Resets internal buffer and diagnostic statistics */
  public reset(): void {
    this.writePos = 0;
    this.stats = {
      bytesProcessed: 0,
      framesParsed: 0,
      framingErrors: 0,
      headerResyncs: 0,
      bufferOverflows: 0,
    };
  }
}
