// The QR code for imdusd.com/links/, the page the founder shares in person. Writes, from the repo's own `uqr`:
//
//   public/links/qr.svg   the code as one crisp vector path (the page shows it; print it at any size)
//   public/links/qr.png   2048 x 2048, for stickers and print shops that want a bitmap
//
// Error correction H (survives about 30% damage: a scuffed sticker, a logo laid over it) and a quiet zone of
// four modules, the minimum the standard asks for. Dark on white, always: scanners read that best, in either
// theme. The PNG is encoded here (one grey channel, node's zlib), so the script needs no image library.
//
//   node scripts/links-qr.mjs                 regenerate the two files
//   node scripts/links-qr.mjs --copy <dir>    also write qr.svg, qr-2048.png and card.png (1200 x 1500: the code,
//                                             "imdUSD" and "imdusd.com/links", for a lock screen) into <dir>;
//                                             the card is drawn by Playwright, so it is only made on request.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import { encode } from "uqr";

export const LINKS_URL = "https://imdusd.com/links/";
const QUIET = 4;
const here = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(here, "../public/links");

const qr = encode(LINKS_URL, { ecc: "H", border: QUIET });
const n = qr.size; // modules across, quiet zone included

/** One path: a horizontal run of dark modules per segment, so the file is small and has no hairline seams. */
function svg() {
  let d = "";
  qr.data.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (x + w < n && row[x + w]) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * 10}" height="${n * 10}" shape-rendering="crispEdges">` +
    `<title>QR code: ${LINKS_URL}</title>` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>\n`
  );
}

/** A greyscale PNG of the code, `size` pixels square, whole pixels per module, centred (the spare pixels widen the
 * quiet zone). */
function png(size) {
  const scale = Math.floor(size / n);
  const pad = Math.floor((size - scale * n) / 2);
  const raw = Buffer.alloc((size + 1) * size, 255);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    const my = Math.floor((y - pad) / scale);
    if (my < 0 || my >= n) continue;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor((x - pad) / scale);
      if (mx >= 0 && mx < n && qr.data[my][mx]) raw[y * (size + 1) + 1 + x] = 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The lock-screen card: the code, the name and the address under it, black on white, 1200 x 1500. */
async function card(code) {
  const { chromium } = await import("playwright");
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 1500 }, deviceScaleFactor: 1 });
  await p.setContent(`<!doctype html><html><head><style>
    html,body{margin:0;width:1200px;height:1500px;background:#fff;color:#000}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;
      font-family:"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace}
    .qr{width:960px;height:960px}.qr svg{width:100%;height:100%;display:block}
    h1{margin:0;font-size:120px;font-weight:400;letter-spacing:-0.045em;line-height:1}
    h1 b{font-weight:700}p{margin:0;font-size:52px;letter-spacing:-0.02em}
  </style></head><body><div class="qr">${code}</div><h1>imd<b>USD</b></h1><p>imdusd.com/links</p></body></html>`);
  const shot = await p.screenshot({ type: "png" });
  await b.close();
  return shot;
}

mkdirSync(out, { recursive: true });
const code = svg();
const bitmap = png(2048);
writeFileSync(resolve(out, "qr.svg"), code);
writeFileSync(resolve(out, "qr.png"), bitmap);
console.log(`links-qr: ${LINKS_URL} -> version ${qr.version}, ${n} modules with a ${QUIET}-module quiet zone, ECC H`);
const copy = process.argv.indexOf("--copy");
if (copy >= 0) {
  const dir = resolve(process.argv[copy + 1]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "qr.svg"), code);
  writeFileSync(resolve(dir, "qr-2048.png"), bitmap);
  writeFileSync(resolve(dir, "card.png"), await card(code));
  console.log(`links-qr: copies and card.png in ${dir}`);
}
