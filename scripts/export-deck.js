/**
 * Export frontend/deck.html to PNG slides and a PDF.
 *
 *   node scripts/export-deck.js            -> dist/deck/*.png + deck.pdf
 *   node scripts/export-deck.js --scale 3  -> 3840x2160 slides
 *
 * Why this exists rather than "just screenshot the page": the deck pulls
 * Archivo / Inter / JetBrains Mono from Google Fonts, so a machine that
 * cannot reach the CDN silently renders the whole deck in fallback fonts and
 * the exported images look nothing like the page. This script downloads the
 * font files once, inlines them as data URIs, and asserts the faces actually
 * registered before it writes anything.
 *
 * Needs playwright:  npm i -D playwright && npx playwright install chromium
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const DECK = path.join(ROOT, "frontend", "deck.html");
const OUT = path.join(ROOT, "dist", "deck");

const SCALE = (() => {
  const i = process.argv.indexOf("--scale");
  const n = i >= 0 ? Number(process.argv[i + 1]) : 2;
  return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 2;
})();

const SLIDE_NAMES = [
  "01-title", "02-problem", "03-solution", "04-demo", "05-traction",
  "06-market", "07-competition", "08-gtm", "09-team", "10-ask",
];

function get(url) {
  return new Promise((resolve, reject) => {
    // Google Fonts serves woff2 with /* latin */ subset comments only to a
    // UA it recognises as a modern browser; anything vaguer gets one big TTF.
    const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
               "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    https.get(url, { headers: { "user-agent": UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(url + " -> HTTP " + res.statusCode));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

/** Fetch the Google Fonts CSS and inline each latin face as a data URI. */
async function inlineFonts(html) {
  const m = html.match(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)">/);
  if (!m) return html;
  const cssUrl = m[1].replace(/&amp;/g, "&");
  const css = (await get(cssUrl)).toString("utf8");

  // Latin only: the other subsets would multiply the payload for glyphs no
  // slide uses.
  const parts = css.split(/\/\* ([a-z0-9-]+) \*\//);
  let blocks = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === "latin") blocks.push(parts[i + 1]);
  }
  // Some responses carry no subset comments at all; fall back to every face.
  if (!blocks.length) blocks = css.match(/@font-face\s*\{[^}]+\}/g) || [];

  const out = [];
  for (const body of blocks) {
    const u = body.match(/src: url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/);
    if (!u) continue;
    const file = await get(u[1]);
    const fmt = /\.ttf/.test(u[1]) ? "font/ttf" : "font/woff2";
    out.push(
      body.replace(u[1], "data:" + fmt + ";base64," + file.toString("base64"))
          .replace(/\n\s*unicode-range:[^;]+;/g, "")
          .trim()
    );
  }
  if (!out.length) throw new Error("No latin faces resolved from " + cssUrl);
  console.log("  inlined " + out.length + " font faces");
  return html.replace(m[0], "<style>\n" + out.join("\n") + "\n</style>");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  console.log("Preparing deck…");
  let html = fs.readFileSync(DECK, "utf8");
  if (!/meta charset/i.test(html)) {
    // Without this the browser sniffs the encoding, and a large ASCII font
    // block pushes the first non-ASCII byte past the sniffing window — every
    // em dash then renders as mojibake.
    throw new Error("frontend/deck.html is missing <meta charset=\"utf-8\">");
  }
  html = await inlineFonts(html);

  const tmp = path.join(OUT, ".deck-embedded.html");
  fs.writeFileSync(tmp, html, "utf8");

  // CHROMIUM_PATH lets a machine with a browser Playwright didn't install
  // itself (CI images, sandboxes) point at the one it already has.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: SCALE,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("file://" + tmp);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);

  const faces = await page.evaluate(() => document.fonts.size);
  if (!faces) throw new Error("No font faces registered — the deck would export in fallback fonts.");
  console.log("  " + faces + " font faces active");

  const mojibake = await page.evaluate(() => {
    const hits = document.body.innerText.match(/Ã.|â€.|Â./g) || [];
    return [...new Set(hits)].slice(0, 5);
  });
  if (mojibake.length) throw new Error("Encoding is wrong — found " + mojibake.join(" "));

  // The helper banner is for people reading the page, not for a slide.
  await page.evaluate(() => { const n = document.querySelector(".note"); if (n) n.style.display = "none"; });

  const slides = await page.$$(".slide");
  console.log("Exporting " + slides.length + " slides at " + (1280 * SCALE) + "x" + (720 * SCALE) + "…");
  for (let i = 0; i < slides.length; i++) {
    const name = SLIDE_NAMES[i] || "slide-" + String(i + 1).padStart(2, "0");
    const box = await slides[i].boundingBox();
    if (Math.round(box.height) !== 720) {
      console.log("  ! " + name + " is " + Math.round(box.height) + "px tall, expected 720 — content may be clipped");
    }
    await slides[i].screenshot({ path: path.join(OUT, name + ".png") });
    console.log("  " + name + ".png");
  }

  await page.pdf({
    path: path.join(OUT, "agent-ctos-deck.pdf"),
    width: "1280px", height: "720px", printBackground: true, pageRanges: "1-10",
  });
  console.log("  agent-ctos-deck.pdf");

  fs.unlinkSync(tmp);
  await browser.close();

  if (errors.length) {
    console.log("JS errors during render:\n  " + [...new Set(errors)].join("\n  "));
    process.exit(1);
  }
  console.log("\nDone -> " + path.relative(ROOT, OUT));
})().catch((e) => {
  console.error("\nExport failed:", e.message);
  process.exit(1);
});
