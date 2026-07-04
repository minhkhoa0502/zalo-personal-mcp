/**
 * Image dimension/size reader for zca-js's `imageMetadataGetter` option.
 * zca-js's docs use `sharp` for this; we parse the header ourselves to avoid a
 * native dependency. Supports PNG, JPEG, GIF, and WEBP (the formats Zalo sends
 * as photos). Returns null for anything we can't parse.
 */
import { readFileSync } from "node:fs";

function readDimensions(b: Buffer): { w: number; h: number } | null {
  // PNG: IHDR width/height at bytes 16..24 (big-endian)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // GIF: logical screen size at bytes 6..10 (little-endian)
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  // JPEG: scan for a Start-Of-Frame marker
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1];
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      o += 2 + b.readUInt16BE(o + 2); // skip this segment
    }
  }
  // WEBP (RIFF/WEBP container), three sub-formats
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const fmt = b.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const b0 = b[21], b1 = b[22], b2 = b[23], b3 = b[24];
      return {
        w: 1 + (((b1 & 0x3f) << 8) | b0),
        h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (fmt === "VP8X") {
      return {
        w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    }
  }
  return null;
}

export async function imageMetadataGetter(
  filePath: string,
): Promise<{ width: number; height: number; size: number } | null> {
  const buf = readFileSync(filePath);
  const dim = readDimensions(buf);
  return dim ? { width: dim.w, height: dim.h, size: buf.length } : null;
}
