import { describe, expect, it } from "vitest";
import {
  decodeSignMagnitude,
  encodeSignMagnitude,
  parseLD2450Frame,
  serializeLD2450Frame,
  LD2450StreamParser,
  LD2450_FRAME_LENGTH,
} from "@/lib/radar/ld2450-parser";

describe("Phase 5.2: HLK-LD2450 UART Protocol Integration", () => {
  describe("Sign-and-Magnitude Arithmetic", () => {
    it("correctly encodes and decodes positive coordinates and speeds", () => {
      const val = 1250;
      const encoded = encodeSignMagnitude(val);
      expect(encoded).toBe(1250);
      expect((encoded & 0x8000) === 0).toBe(true);
      expect(decodeSignMagnitude(encoded)).toBe(1250);
    });

    it("correctly encodes and decodes negative coordinates and speeds with MSB sign bit", () => {
      const val = -1250;
      const encoded = encodeSignMagnitude(val);
      // Bit 15 set: 0x8000 | 1250 = 32768 + 1250 = 34018
      expect(encoded).toBe(0x8000 | 1250);
      expect((encoded & 0x8000) !== 0).toBe(true);
      expect(decodeSignMagnitude(encoded)).toBe(-1250);
    });

    it("handles zero gracefully without negative zero distortion", () => {
      const zeroEnc = encodeSignMagnitude(0);
      expect(zeroEnc).toBe(0);
      expect(decodeSignMagnitude(0)).toBe(0);
      // Explicit 0x8000 (negative 0) decodes to -0 which equals 0
      expect(decodeSignMagnitude(0x8000)).toBe(-0);
    });
  });

  describe("Deterministic Protocol Frame Parsing", () => {
    it("parses a documented 30-byte frame with a single target", () => {
      // Create frame: Target 1 at X = -500mm, Y = 2500mm, Speed = +25 cm/s, Res = 100mm
      const bytes = serializeLD2450Frame([
        { target_id: 1, x_mm: -500, y_mm: 2500, speed_cms: 25, resolution_mm: 100 },
      ]);

      expect(bytes.length).toBe(LD2450_FRAME_LENGTH);
      // Verify header 0xAA 0xFF 0x03 0x00
      expect(bytes[0]).toBe(0xaa);
      expect(bytes[1]).toBe(0xff);
      expect(bytes[2]).toBe(0x03);
      expect(bytes[3]).toBe(0x00);
      // Verify footer 0x55 0xCC
      expect(bytes[28]).toBe(0x55);
      expect(bytes[29]).toBe(0xcc);

      const parsed = parseLD2450Frame(bytes);
      expect(parsed).not.toBeNull();
      expect(parsed?.targets.length).toBe(1);

      const t1 = parsed!.targets[0]!;
      expect(t1.target_id).toBe(1);
      expect(t1.x_mm).toBe(-500);
      expect(t1.y_mm).toBe(2500);
      expect(t1.speed_cms).toBe(25);
    });

    it("parses 3 simultaneous targets with distinct positive and negative coordinates", () => {
      const inputTargets = [
        { target_id: 1, x_mm: -1500, y_mm: 2000, speed_cms: -15, resolution_mm: 80 },
        { target_id: 2, x_mm: 750, y_mm: 3200, speed_cms: 30, resolution_mm: 95 },
        { target_id: 3, x_mm: -250, y_mm: 4100, speed_cms: 0, resolution_mm: 110 },
      ];

      const raw = serializeLD2450Frame(inputTargets);
      const parsed = parseLD2450Frame(raw);

      expect(parsed).not.toBeNull();
      expect(parsed?.targets.length).toBe(3);

      expect(parsed?.targets[0]).toEqual({
        target_id: 1,
        x_mm: -1500,
        y_mm: 2000,
        speed_cms: -15,
      });

      expect(parsed?.targets[1]).toEqual({
        target_id: 2,
        x_mm: 750,
        y_mm: 3200,
        speed_cms: 30,
      });

      expect(parsed?.targets[2]).toEqual({
        target_id: 3,
        x_mm: -250,
        y_mm: 4100,
        speed_cms: 0,
      });
    });

    it("rejects corrupted header or corrupted footer", () => {
      const valid = serializeLD2450Frame([{ target_id: 1, x_mm: 100, y_mm: 1000, speed_cms: 10 }]);

      // Corrupt header byte 0
      const badHeader = new Uint8Array(valid);
      badHeader[0] = 0xbb;
      expect(parseLD2450Frame(badHeader)).toBeNull();

      // Corrupt footer byte 29
      const badFooter = new Uint8Array(valid);
      badFooter[29] = 0xdd;
      expect(parseLD2450Frame(badFooter)).toBeNull();

      // Truncated buffer
      expect(parseLD2450Frame(valid.subarray(0, 20))).toBeNull();
    });
  });

  describe("Non-blocking Stream Parser (LD2450StreamParser)", () => {
    it("extracts frames across fragmented UART chunks", () => {
      const stream = new LD2450StreamParser();
      const frameBytes = serializeLD2450Frame([
        { target_id: 1, x_mm: -600, y_mm: 2200, speed_cms: 15 },
      ]);

      // Fragment into 3 arbitrary chunks: 8 bytes, 14 bytes, 8 bytes
      const chunk1 = frameBytes.subarray(0, 8);
      const chunk2 = frameBytes.subarray(8, 22);
      const chunk3 = frameBytes.subarray(22, 30);

      const f1 = stream.pushChunk(chunk1);
      expect(f1.length).toBe(0); // Not enough bytes yet

      const f2 = stream.pushChunk(chunk2);
      expect(f2.length).toBe(0);

      const f3 = stream.pushChunk(chunk3);
      expect(f3.length).toBe(1); // Frame completed!

      expect(f3[0]?.targets[0]?.x_mm).toBe(-600);
      expect(f3[0]?.targets[0]?.y_mm).toBe(2200);
      expect(stream.stats.framesParsed).toBe(1);
    });

    it("resynchronizes when corrupted garbage noise precedes a valid frame", () => {
      const stream = new LD2450StreamParser();
      const validFrame = serializeLD2450Frame([
        { target_id: 2, x_mm: 400, y_mm: 1500, speed_cms: -10 },
      ]);

      // Prepend 17 random noise bytes
      const noise = new Uint8Array([
        0x12, 0x34, 0xaa, 0x55, 0x00, 0xff, 0x88, 0x99, 0xaa, 0xff, 0x02, 0x00, 0x11, 0x22, 0x33,
        0x44, 0x55,
      ]);

      const streamBytes = new Uint8Array(noise.length + validFrame.length);
      streamBytes.set(noise, 0);
      streamBytes.set(validFrame, noise.length);

      const parsed = stream.pushChunk(streamBytes);
      expect(parsed.length).toBe(1);
      expect(parsed[0]?.targets[0]?.target_id).toBe(2);
      expect(parsed[0]?.targets[0]?.x_mm).toBe(400);
      expect(stream.stats.framesParsed).toBe(1);
    });

    it("parses multiple consecutive back-to-back frames in one chunk", () => {
      const stream = new LD2450StreamParser();
      const f1Bytes = serializeLD2450Frame([{ target_id: 1, x_mm: 100, y_mm: 1000, speed_cms: 5 }]);
      const f2Bytes = serializeLD2450Frame([
        { target_id: 1, x_mm: 200, y_mm: 1100, speed_cms: 10 },
      ]);

      const combined = new Uint8Array(60);
      combined.set(f1Bytes, 0);
      combined.set(f2Bytes, 30);

      const results = stream.pushChunk(combined);
      expect(results.length).toBe(2);
      expect(results[0]?.targets[0]?.x_mm).toBe(100);
      expect(results[1]?.targets[0]?.x_mm).toBe(200);
      expect(stream.stats.framesParsed).toBe(2);
    });
  });
});
