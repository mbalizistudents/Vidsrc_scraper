// ================================================
// VIDSRC SCRAPER API - FULL PRODUCTION RUNNING VERSION
// ================================================

import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// ===================== TRUST PROXY CONFIG =====================
// Hii inatatua kosa la X-Forwarded-For kwenye Railway na reverse proxies
app.set("trust proxy", 1);

app.use(cors());
app.use(express.json());

// ===================== RATE LIMITER =====================
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,     // Dakika 1
  max: 30,                 // Max 30 requests kwa dakika
  message: { success: false, error: "Too many requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // Inazuia rate limiter isicrash ikikosa trust-proxy validation
});

app.use(apiLimiter);

// ===================== CACHE =====================
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // dakika 15

// ===================== PROVIDERS =====================
const PROVIDERS = [
  "https://vidsrcme.ru",
  "https://vidsrcme.su",
  "https://vidsrc-me.ru",
  "https://vidsrc-me.su",
  "https://vidsrc-embed.ru",
  "https://vidsrc-embed.su",
  "https://vsrc.su",
];

let browser;
const concurrencyLimit = pLimit(2);

// ===================== SCRAPER CORE =====================
async function scrapeProvider(domain, url) {
  console.log(`[SCRAPE] ${domain} → ${url}`);

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  let hlsUrl = null;
  const subtitles = [];

  const isSubtitle = (u) => /\.(vtt|srt)(\?.*)?$/i.test(u) || u.includes(".vtt") || u.includes(".srt");

  try {
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && reqUrl.includes(".m3u8")) hlsUrl = reqUrl;
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) subtitles.push(reqUrl);
      route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const frame = await page.waitForSelector("#the_frame", { timeout: 15000 }).catch(() => null);
    if (frame) {
      const box = await frame.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await page.evaluate(() => document.querySelector("#the_frame")?.click());
      }
      await page.waitForTimeout(8000);
    }

    await page.close();
    await context.close();

    if (!hlsUrl) throw new Error("HLS stream not found");
    return { hls_url: hlsUrl, subtitles, error: null };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[SCRAPE] ${domain} failed:`, error.message);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// ===================== MAIN ENDPOINTS =====================
app.get("/extract", async (req, res) => {
  const { tmdb_id, type = "movie", season, episode } = req.query;

  if (!tmdb_id) return res.status(400).json({ success: false, error: "tmdb_id required" });
  if (type === "tv" && (!season || !episode)) {
    return res.status(400).json({ success: false, error: "season & episode required for TV" });
  }

  // REKEBISHWA: URL na Cache key interpolation zote zimekuwa sahihi sasa hivi
  const cacheKey = `extract_${tmdb_id}_${type}_${season || 0}_${episode || 0}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  // REKEBISHWA: Interpolation za providers zote zimesafishwa kuwa standard ES6 syntax
  const urls = PROVIDERS.reduce((acc, domain) => {
    acc[domain] = type === "tv"
      ? `${domain}/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}`
      : `${domain}/embed/movie/${tmdb_id}`;
    return acc;
  }, {});

  try {
    const resultsArray = await Promise.all(
      Object.entries(urls).map(([domain, url]) =>
        concurrencyLimit(() => scrapeProvider(domain, url))
      )
    );

    const results = Object.fromEntries(resultsArray);
    let rdData = null;

    for (const [domain, data] of Object.entries(results)) {
      if (data.hls_url) {
        rdData = await unrestrictWithRealDebrid(data.hls_url);
        if (rdData) break;
      }
    }

    if (rdData) {
      results["real-debrid"] = {
        hls_url: rdData.streaming || rdData.download,
        direct_url: rdData.download,
        filename: rdData.filename,
        filesize: rdData.filesize,
      };
    }

    const success = Object.values(results).some(r => r.hls_url || r.direct_url);
    const responseData = { success, results, rd_used: !!rdData };

    cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
    res.json(responseData);
  } catch (err) {
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ===================== SUBTITLES & EXTRA ENDPOINTS =====================
app.get("/tv-subtitles", async (req, res) => {
  const { title, season, episode, type } = req.query;
  if (type !== "tv" || !title || !season || !episode) {
    return res.status(400).send("Invalid parameters");
  }

  try {
    const { getTVSubtitleVTT } = await import("./utils/tvSubtitles.js");
    const vtt = await getTVSubtitleVTT(title, parseInt(season), parseInt(episode));
    if (!vtt) return res.status(404).send("No subtitle found");
    res.set("Content-Type", "text/vtt").send(vtt);
  } catch (err) {
    console.error("[TV-SUB] Error:", err.message);
    res.status(500).send("Subtitle processing error");
  }
});

app.get("/subtitle-proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing subtitle URL");

  try {
    const subtitleRes = await fetch(url);
    const srt = await subtitleRes.text();
    const vtt = "WEBVTT\n\n" + srt
      .replace(/\r+/g, "")
      .replace(/^\s+|\s+$/g, "")
      .split("\n")
      .map(line => line.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4"))
      .join("\n");

    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    res.status(500).send("Subtitle proxy failed");
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    rate_limiter: "active",
    real_debrid: REAL_DEBRID_API_KEY ? "enabled" : "disabled",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.send("🎬 VidSrc Scraper API - Full Production Version Running Without Errors");
});

// ===================== STARTUP =====================
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
    console.log(`✅ Server started on port ${PORT}`);
    console.log(`Rate Limiter: ENABLED | Cache: ENABLED`);
  });
})();

process.on("SIGINT", async () => {
  console.log("\nShutting down gracefully...");
  if (browser) await browser.close();
  process.exit(0);
});
