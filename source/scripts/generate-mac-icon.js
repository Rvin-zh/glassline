'use strict';

// Generates assets/open-cluely.icns from assets/open-cluely.png.
//
// Writes a minimal Apple `icns` container with a single `ic09` chunk
// (512x512 PNG, the canonical representation electron-builder accepts).
// This avoids requiring libicns / iconutil on Fedora and keeps the
// packaging contract self-contained.
//
// Throws when the source PNG is missing.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_PNG = path.join(ROOT, 'assets', 'open-cluely.png');
const OUTPUT_ICNS = path.join(ROOT, 'assets', 'open-cluely.icns');

// icns magic: 'icns' (0x69636E73)
const ICNS_MAGIC = Buffer.from('icns', 'ascii');
// ic09 = 512x512 PNG (Apple's documented OSType for 512×512 uncompressed)
const IC09_TAG = Buffer.from('ic09', 'ascii');

function buildIcns(pngBuffer) {
  // icns chunk = 4-byte OSType + 4-byte big-endian size (incl. tag+size) + payload
  const chunkPayload = pngBuffer;
  const chunkSize = chunkPayload.length + 8;
  const chunk = Buffer.concat([
    IC09_TAG,
    Buffer.alloc(4)
  ]);
  chunk.writeUInt32BE(chunkSize, 4);
  // Total file size = magic(4) + file size field(4) + chunk
  const fileSize = 4 + 4 + chunkSize;
  const file = Buffer.concat([
    ICNS_MAGIC,
    Buffer.alloc(4),
    chunk,
    chunkPayload
  ]);
  file.writeUInt32BE(fileSize, 4);
  return file;
}

function main() {
  if (!fs.existsSync(SOURCE_PNG)) {
    throw new Error(`Mac icon source missing: ${SOURCE_PNG}`);
  }
  const png = fs.readFileSync(SOURCE_PNG);
  const icns = buildIcns(png);
  fs.writeFileSync(OUTPUT_ICNS, icns);
  console.log(`Wrote ${OUTPUT_ICNS} (${icns.length} bytes)`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildIcns,
  main,
  SOURCE_PNG,
  OUTPUT_ICNS
};
