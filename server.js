import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;

app.use(cors());
app.use(express.json());

const PROVIDERS = [
  "https://vidsrc.xyz",
  "https://vidsrc.in",
  "https://vidsrc.pm",
  "https://vidsrc.net",
];

let browser;
const limit = pLimit(2);

// ===================== SCRAPER FUNCTION =====================
async function scrapeProvider(domain, url) {
  console.log(`\n[${domain}] Scraping: ${url}`);

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  let hlsUrl = null;
  const subtitles = [];

  const isSubtitle = (u) => /\.(vtt|srt)(\?.*)?$/.test(u) || u.includes(".vtt") || u.includes(".srt");

  try {
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) {
        hlsUrl = reqUrl;
      }
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
      }
      route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Click the frame to trigger video load
    const frameDiv = await page.waitForSelector("#the_frame", { timeout: 15000 }).catch(() => null);
    if (frameDiv) {
      const box = await frameDiv.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await page.evaluate(() => document.querySelector("#the_frame")?.click());
      }
      await page.waitForTimeout(8000);
    }

    await page.close();
    await context.close();

    if (!hlsUrl) throw new Error("No HLS found");
    return { hls_url: hlsUrl, subtitles, error: null };

  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${domain}] Failed:`, error.message);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// ===================== MAIN ENDPOINT =====================
app.get("/extract", async (req, res) => {
  const { tmdb_id, type = "movie", season, episode } = req.query;

  if (!tmdb_id) {
    return res.status(400).json({ success: false, error: "tmdb_id is required" });
  }
  if (type === "tv" && (!season || !episode)) {
    return res.status(400).json({ success: false, error: "season and episode required for TV" });
  }

  const urls = PROVIDERS.reduce((acc, domain) => {
    acc[domain] = type === "tv"
      ? `\( {domain}/embed/tv?tmdb= \){tmdb_id}&season=\( {season}&episode= \){episode}`
      : `\( {domain}/embed/movie/ \){tmdb_id}`;
    return acc;
  }, {});

  try {
    const resultsArr = await Promise.all(
      Object.entries(urls).map(([domain, url]) =>
        limit(() => scrapeProvider(domain, url))
      )
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some(r => r.hls_url !== null);

    res.json({ success, results });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// ===================== SUBTITLES (Unaweza kuacha kama ulivyokuwa) =====================
app.get("/movie-subtitles", async (req, res) => {
  // ... weka code yako ya zamani hapa (au nikupe mpya kama unataka)
  res.json({ success: false, error: "Not implemented yet" });
});

app.get("/", (req, res) => {
  res.send("🎬 VidSrc Scraper API Running (No Real-Debrid)");
});

// ===================== START SERVER =====================
(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
})();

process.on("SIGINT", async () => {
  if (browser) await browser.close();
  process.exit();
});
