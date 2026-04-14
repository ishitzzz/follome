// Generate minimal PNG icons for FolloMe extension
// Run: node scripts/generate-icons.js

const fs = require('fs');
const path = require('path');

// Minimal PNG creator (no external deps)
// Creates a simple solid-color PNG with a gradient look

function createPNG(width, height, colorFn) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  
  // Raw pixel data with filter bytes
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorFn(x, y, width, height);
      rawData.push(r, g, b);
    }
  }
  
  const rawBuf = Buffer.from(rawData);
  
  // Compress with zlib
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(rawBuf);
  
  // Build chunks
  const chunks = [];
  
  // IHDR
  chunks.push(makeChunk('IHDR', ihdr));
  
  // IDAT
  chunks.push(makeChunk('IDAT', compressed));
  
  // IEND
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));
  
  return Buffer.concat([signature, ...chunks]);
}

function makeChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  // CRC32
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  
  return Buffer.concat([length, typeBuffer, data, crcBuf]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Color function for FolloMe icon
function iconColor(x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const normDist = dist / maxDist;
  const cornerR = w * 0.18;
  
  // Rounded rect check (approximate)
  const margin = cornerR;
  const inRect = x >= 0 && x < w && y >= 0 && y < h;
  const inCorner = (
    (x < margin && y < margin && Math.sqrt((x-margin)**2 + (y-margin)**2) > margin) ||
    (x > w-margin && y < margin && Math.sqrt((x-w+margin)**2 + (y-margin)**2) > margin) ||
    (x < margin && y > h-margin && Math.sqrt((x-margin)**2 + (y-h+margin)**2) > margin) ||
    (x > w-margin && y > h-margin && Math.sqrt((x-w+margin)**2 + (y-h+margin)**2) > margin)
  );
  
  if (!inRect || inCorner) {
    return [0, 0, 0]; // Transparent (black for RGB)
  }
  
  // Background
  const bgR = Math.round(10 + (y / h) * 10);
  const bgG = Math.round(10 + (y / h) * 5);
  const bgB = Math.round(15 + (y / h) * 15);
  
  // Star shape — 4-pointed
  const angle = Math.atan2(dy, dx);
  const starRadius = w * 0.32;
  const innerRadius = w * 0.13;
  const points = 4;
  
  // Calculate star boundary at this angle
  const sector = (angle + Math.PI) / (Math.PI / points);
  const frac = sector % 2;
  let starBoundary;
  if (frac < 1) {
    starBoundary = innerRadius + (starRadius - innerRadius) * (1 - frac);
  } else {
    starBoundary = innerRadius + (starRadius - innerRadius) * (frac - 1);
  }
  
  if (dist < starBoundary) {
    // Inside star — gradient from indigo to purple to pink
    const t = (angle + Math.PI) / (2 * Math.PI);
    const r = Math.round(129 + t * 115);  // 129 → 244
    const g = Math.round(140 - t * 28);   // 140 → 112
    const b = Math.round(248 - t * 66);   // 248 → 182
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }
  
  // Center glow
  if (dist < w * 0.12) {
    const glowT = dist / (w * 0.12);
    const r = Math.round(129 + (1 - glowT) * 40);
    const g = Math.round(140 + (1 - glowT) * 30);
    const b = Math.round(248);
    return [r, g, b];
  }
  
  return [bgR, bgG, bgB];
}

// Generate icons
const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

[16, 48, 128].forEach(size => {
  const png = createPNG(size, size, iconColor);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
});

console.log('Done! Icons generated.');
