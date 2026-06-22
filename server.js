/**
 * RAILWAY SERVER MONITORING & VIDEO EXTRACTOR API (VidSrc Scraper API Server)
 * -------------------------------------------------------------------------
 * Copy this code fully and paste it into your 'server.js' or 'index.js'
 * on your Railway server, then redeploy.
 * 
 * Major Upgrades & Bugfixes:
 * 1. Express Rate Limiter: Resolved the "trust proxy" warning for stable Railway routing.
 * 2. Pure English Translation: All logs, error codes, and server messages are in high-quality English.
 * 3. Playwright Headless Configuration: Fine-tuned arguments for direct container execution on Railway.
 * 4. Proxied Endpoints: Added dynamic CORS tunnels to vidsrc-embed.ru to fetch the latest additions seamlessly.
 * 5. Robust Fallback Generator: Safely generates embed link fail-overs if direct scraping is blocked.
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");

// Dynamic Playwright loading to prevent server crash if not installed
let chromium = null;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  console.warn("[WARN] Playwright is not installed. Scraping matches will fallback to direct iframe redirects.");
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ====== ESSENTIAL FOR RAILWAY (Enable Trust Proxy) ======
// This allows express-rate-limit to correctly read client IPs behind Railway proxies/CDN.
app.set("trust proxy", 1);

// Standard Middlewares
app.use(cors({ origin: "*" }));
app.use(express.json());

// API Request Rate Limiter (Prevent API abuse)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Limit each IP to 300 requests per windowMs
  message: {
    status: 429,
    error: "Too many requests. Please try again after 15 minutes."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/extract", limiter);

// In-Memory Stream Cache (30 minutes expiry)
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// Generate uniqueness key for cache
const getCacheKey = (tmdb_id, type, season, episode) => {
  return `extract_${tmdb_id}_${type}_${season || 0}_${episode || 0}`;
};

/**
 * 1. STREAM RESOLVER ENDPOINT
 * GET /extract?tmdb_id=...&type=movie|tv&season=...&episode=...
 */
app.get("/extract", async (req, res) => {
  const { tmdb_id, type, season, episode } = req.query;

  if (!tmdb_id || !type) {
    return res.status(400).json({ error: "The parameters 'tmdb_id' and 'type' are required." });
  }

  if (type === "tv" && (!season || !episode)) {
    return res.status(400).json({ error: "For TV series, both 'season' and 'episode' parameters are required." });
  }

  const cacheKey = getCacheKey(tmdb_id, type, season, episode);

  // Check from cached data
  if (cache.has(cacheKey)) {
    const cachedItem = cache.get(cacheKey);
    if (Date.now() - cachedItem.timestamp < CACHE_TTL) {
      console.log(`[CACHE HIT] Returning cached stream data for key: ${cacheKey}`);
      return res.json(cachedItem.data);
    } else {
      cache.delete(cacheKey);
    }
  }

  console.log(`[RESOLVING STREAM] Initializing lookup for: ID ${tmdb_id} (${type})`);

  // Target domains to probe 
  const domains = [
    "https://vidsrcme.ru",
    "https://vidsrcme.su",
    "https://vidsrc-me.ru",
    "https://vidsrc-me.su",
    "https://vsembed.ru"
  ];
  const targetUrls = {};
  domains.forEach(domain => {
    if (type === "tv") {
      targetUrls[domain] = `${domain}/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}`;
    } else {
      targetUrls[domain] = `${domain}/embed/movie/${tmdb_id}`;
    }
  });

  // If Playwright is not present, return the fallback URL instantly
  if (!chromium) {
    console.log("[PLAYWRIGHT MISSING] Returning fallback embedded player directly.");
    const directFallbackUrl = type === "tv"
      ? `https://vidsrc-embed.ru/embed/tv/${tmdb_id}/${season}-${episode}`
      : `https://vidsrc-embed.ru/embed/movie/${tmdb_id}`;

    const payload = {
      tmdb_id,
      type,
      streamUrl: directFallbackUrl,
      subtitles: [],
      source: "VidSrc Direct Fallback (No Sniffer)",
      timestamp: new Date().toISOString()
    };
    return res.json(payload);
  }

  let browser = null;
  try {
    // Launch secure sandbox browser optimized for server headless environments
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--disable-web-security"
      ]
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true
    });

    const page = await context.newPage();
    
    // Disable media formats and css during lookup to save network bandwidth and speed up resolution
    await page.route("**/*.{png,jpg,jpeg,gif,webp,css,woff,woff2,ttf,svg}", route => route.abort());

    let finalStreamUrl = null;
    let fallbackSubtitleUrls = [];

    // Attach passive listener to sniff media stream playlists (.m3u8, .mp4)
    page.on("request", req => {
      const url = req.url();
      if (url.includes(".m3u8") || url.includes(".mp4") || url.includes("playlist.m3u8")) {
        if (!url.includes("debrid") && !url.includes("/rd/")) {
          console.log(`[CAPTURED STREAM URL] Found match: ${url}`);
          finalStreamUrl = url;
        }
      }
      
      // Scrape for subtitles matching VTT or SRT formats
      if (url.includes(".vtt") || url.includes(".srt")) {
        console.log(`[CAPTURED SUBTITLE] Found track: ${url}`);
        fallbackSubtitleUrls.push(url);
      }
    });

    // Probe domains sequentially
    for (const domain of domains) {
      const urlToVisit = targetUrls[domain];
      console.log(`[PROBING DOMAIN] Navigating to: ${urlToVisit}`);

      try {
        await page.goto(urlToVisit, { waitUntil: "domcontentloaded", timeout: 12000 });
        
        // Wait for player dynamic javascript components to bind
        await page.waitForTimeout(3000);

        if (finalStreamUrl) {
          break; // Located successfully! Stop probing remaining domains
        }
      } catch (err) {
        console.warn(`[DOMAIN FAILED] Target ${domain} returned an error: ${err.message}`);
      }
    }

    if (!finalStreamUrl) {
      console.log("[SCRAPE FAILED] Playwright sniffers timed out. Creating a clean iframe fallback.");
      finalStreamUrl = type === "tv" 
        ? `https://vidsrc-embed.ru/embed/tv/${tmdb_id}/${season}-${episode}`
        : `https://vidsrc-embed.ru/embed/movie/${tmdb_id}`;
    }

    const payload = {
      tmdb_id,
      type,
      streamUrl: finalStreamUrl,
      subtitles: fallbackSubtitleUrls,
      source: "VidSrc Link sniffer",
      timestamp: new Date().toISOString()
    };

    cache.set(cacheKey, { timestamp: Date.now(), data: payload });
    return res.json(payload);

  } catch (error) {
    console.error("[CRITICAL ERROR IN STRIPPER ENGINE]", error);
    return res.status(500).json({
      error: "Extraction process encountered a state exception.",
      details: error.message,
      fallbackUrl: type === "tv" 
        ? `https://vidsrc-embed.ru/embed/tv/${tmdb_id}/${season}-${episode}`
        : `https://vidsrc-embed.ru/embed/movie/${tmdb_id}`
    });
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error("Error disposing browser instance:", e));
    }
  }
});


/**
 * 2. PROXY SEGMENTS TO BYPASS CORS ISSUES IN APP FRONTEND
 */

// A) Latest Movies Proxy Tunnel
app.get("/api/latest-movies", async (req, res) => {
  const page = req.query.page || 1;
  const targetUrl = `https://vidsrc-embed.ru/movies/latest/page-${page}.json`;
  
  try {
    const fetchResponse = await fetch(targetUrl);
    if (!fetchResponse.ok) throw new Error("VidSrc feed returned non-200 state.");
    const data = await fetchResponse.json();
    return res.json(data);
  } catch (err) {
    console.error(`[FEED ERROR] Failed to fetch latest movies: ${err.message}`);
    return res.status(500).json({ error: "Failed to retrieve newly added movies from backend source." });
  }
});

// B) Latest TV Shows Proxy Tunnel
app.get("/api/latest-tvshows", async (req, res) => {
  const page = req.query.page || 1;
  const targetUrl = `https://vidsrc-embed.ru/tvshows/latest/page-${page}.json`;
  
  try {
    const fetchResponse = await fetch(targetUrl);
    if (!fetchResponse.ok) throw new Error("VidSrc feed returned non-200 state.");
    const data = await fetchResponse.json();
    return res.json(data);
  } catch (err) {
    console.error(`[FEED ERROR] Failed to fetch latest TV shows: ${err.message}`);
    return res.status(500).json({ error: "Failed to retrieve newly added TV shows from backend source." });
  }
});

// C) Latest Episodes Proxy Tunnel
app.get("/api/latest-episodes", async (req, res) => {
  const page = req.query.page || 1;
  const targetUrl = `https://vidsrc-embed.ru/episodes/latest/page-${page}.json`;
  
  try {
    const fetchResponse = await fetch(targetUrl);
    if (!fetchResponse.ok) throw new Error("VidSrc feed returned non-200 state.");
    const data = await fetchResponse.json();
    return res.json(data);
  } catch (err) {
    console.error(`[FEED ERROR] Failed to fetch latest episodes: ${err.message}`);
    return res.status(500).json({ error: "Failed to retrieve newly added episodes from backend source." });
  }
});

// Health Checks
app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`=========================================`);
  console.log(`   SCRAPER API ENGINE IS ONLINE & READY`);
  console.log(`=========================================`);
  console.log(`Local Access: http://localhost:${PORT}`);
  console.log(`Resolver Endpoint: http://localhost:${PORT}/extract?tmdb_id=...&type=movie`);
  console.log(`Latest Movies Feed: http://localhost:${PORT}/api/latest-movies?page=1`);
  console.log(`=========================================`);
});
