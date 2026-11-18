/**
 * RoomTrace — Ai-Thinker RD-61 60 GHz Raw Interface & Decoder Contract
 *
 * NOTE (RD-61 Verification Status):
 * The hardware UART protocol for firmware #2967 (Standard Point Cloud V1.0.0)
 * is pending physical bench verification. Speculative parsing of raw packets
 * into coordinates or vital signs is strictly prohibited.
 *
 * This module defines the raw packet capture interface and the future decoder
 * abstraction.
 */

import type { RD61Point } from "./types";

export const RD61_TARGET_FIRMWARE = "2967";
export const RD61_IS_PROTOCOL_VERIFIED = false;

export interface RD61RawPacket {
  timestamp: number;
  sequenceNumber: number;
  byteLength: number;
  firmwareVersion: string;
  rawBytes: Uint8Array;
  isVerified: false;
}

export interface RD61DecodeResult {
  points: RD61Point[];
  isVerified: boolean;
  notes: string;
}

/** Future decoder interface for certified firmware revisions */
export interface IRD61PointDecoder {
  readonly supportedFirmware: string;
  readonly isProtocolVerified: boolean;
  decodePacket(packet: RD61RawPacket): RD61DecodeResult;
}

/**
 * Standard unverified pass-through implementation.
 * Safely captures raw packets while refusing speculative mathematical conversions.
 */
export class UnverifiedRD61Decoder implements IRD61PointDecoder {
  public readonly supportedFirmware = RD61_TARGET_FIRMWARE;
  public readonly isProtocolVerified = false;

  public decodePacket(packet: RD61RawPacket): RD61DecodeResult {
    return {
      points: [],
      isVerified: false,
      notes: `Captured ${packet.byteLength} raw bytes for firmware #${packet.firmwareVersion}. Protocol unverified; speculative decoding suppressed.`,
    };
  }
}
