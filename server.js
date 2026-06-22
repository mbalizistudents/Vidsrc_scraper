/**
 * UTUFUATILIAJI WA SEVA YA RAILWAY (VidSrc Scraper API Server)
 * -------------------------------------------------------------
 * Nakili nambari hizi kikamilifu na ubandike kwenye faili lako la 'server.js' au 'index.js'
 * kwenye seva yako ya Railway kisha ufanye deploy upya.
 * 
 * Marekebisho yaliyofanyika hapa:
 * 1. Kufuta hitilafu ya "trust proxy" ya Express Rate Limit inayotokea kwenye Railway.
 * 2. Kurekebisha syntax ya template literals zilizokuwa na makosa ya "\(" badala ya "${}".
 * 3. Kuzuia Playwright kuelekeza kwenye anwani feki kama "( {domain}/embed/movie/ )".
 * 4. Kuongeza Proxy ya "vidsrc-embed.ru" endpoints ili uweze kupata List ya video mpya (Latest).
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const { chromium } = require("playwright"); // Ikiwa unatumia Playwright ku-scrape

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ====== MUHIMU KWA RAILWAY (Rate Limiting Fix) ======
// Hii inaiambia Express kuamini proxy za Railway (kama vile Cloudflare au Load Balancer yao)
// ili "express-rate-limit" isome IP halisi ya mtumiaji badala ya kusababisha vifo vya seva.
app.set("trust proxy", 1);

// Middlewares
app.use(cors({ origin: "*" })); // Huruhusu maombi kutoka kwa vyanzo vyote (ikiwemo app yako ya React)
app.use(express.json());

// Kikomo cha Maombi (Rate Limiter)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // Dakika 15
  max: 300, // Kila IP inaruhusiwa kufanya maombi max 300 kwa kila dakika 15
  message: {
    status: 429,
    error: "Maombi yamezidi kikomo. Tafadhali jaribu tena baada ya dakika 15."
  },
  standardHeaders: true, // Inarudisha habari za kikomo kwenye headers za "RateLimit-*"
  legacyHeaders: false, // Inalemaza headers za zamani za "X-RateLimit-*"
});

app.use("/extract", limiter);

// Hifadhi ya Cache ya Muda (Simple In-Memory Cache)
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // Cache inakaa dakika 30

// Kikokotoo cha ufunguo wa Cache
const getCacheKey = (tmdb_id, type, season, episode) => {
  return `extract_${tmdb_id}_${type}_${season || 0}_${episode || 0}`;
};

/**
 * 1. ENDPOINT KUU YA EXTRACTION
 * GET /extract?tmdb_id=...&type=movie|tv&season=...&episode=...
 */
app.get("/extract", async (req, res) => {
  const { tmdb_id, type, season, episode } = req.query;

  if (!tmdb_id || !type) {
    return res.status(400).json({ error: "Vigezo vya 'tmdb_id' na 'type' ni lazima." });
  }

  if (type === "tv" && (!season || !episode)) {
    return res.status(400).json({ error: "Kwa upande wa TV, 'season' na 'episode' ni lazima." });
  }

  const cacheKey = getCacheKey(tmdb_id, type, season, episode);

  // Angalia kama matokeo yapo kwenye Cache tayari
  if (cache.has(cacheKey)) {
    const cachedItem = cache.get(cacheKey);
    if (Date.now() - cachedItem.timestamp < CACHE_TTL) {
      console.log(`[CACHE HIT] Inarudisha matokeo ya cache kwa: ${cacheKey}`);
      return res.json(cachedItem.data);
    } else {
      cache.delete(cacheKey); // Futa ikiwa imeisha muda
    }
  }

  console.log(`[SCRAPE START] Inatafuta viungo vya: ID ${tmdb_id} (${type})`);

  // Orodha ya domains za kujaribu kufungua
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

  let browser = null;
  try {
    // Kuanzisha Playwright Stealth/Headless Browser
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu"
      ]
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 }
    });

    const page = await context.newPage();
    
    // Zima upakiaji wa picha na css ili kuharakisha kasi ya scraper
    await page.route("**/*.{png,jpg,jpeg,gif,webp,css,woff,woff2,ttf,svg}", route => route.abort());

    let finalStreamUrl = null;
    let fallbackSubtitleUrls = [];

    // Tunasikiliza mtandao ili kukamata muunganisho wa HLS .m3u8 au faili za video
    page.on("request", req => {
      const url = req.url();
      if (url.includes(".m3u8") || url.includes(".mp4") || url.includes("playlist.m3u8")) {
        if (!url.includes("debrid") && !url.includes("/rd/")) {
          console.log(`[CAPTURED STREAM URL] Found match: ${url}`);
          finalStreamUrl = url;
        }
      }
      
      // Kamata Subtitles zozote zinazopatikana njiani (.vtt, .srt)
      if (url.includes(".vtt") || url.includes(".srt")) {
        console.log(`[CAPTURED SUBTITLE] Found track: ${url}`);
        fallbackSubtitleUrls.push(url);
      }
    });

    // Jaribu kupata viungo kwenye domains zote mfululizo
    for (const domain of domains) {
      const urlToVisit = targetUrls[domain];
      console.log(`[SCRAPE TRY] Inafungua anwani: ${urlToVisit}`);

      try {
        await page.goto(urlToVisit, { waitUntil: "domcontentloaded", timeout: 15000 });
        
        // Subiri hadi video ya player ianzishwe (Simulate click if needed)
        await page.waitForTimeout(3000);

        if (finalStreamUrl) {
          break; // Ipatikana! Acha orodha ya domains iliyobaki
        }
      } catch (err) {
        console.warn(`[SCRAPE FAILED] Domain ${domain} imeshindwa: ${err.message}`);
      }
    }

    if (!finalStreamUrl) {
      // Kama Playwright imeshindwa ku-sniff m3u8 moja kwa moja, tunatengeneza fallback safi ya iframe URL
      // lakini kwa kutumia embed safi tuliyopewa badala ya viungo vyenye matangazo.
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

    // Hifadhi kwenye Cache ya ndani ya server kabla ya kurudisha kwa mtumiaji
    cache.set(cacheKey, { timestamp: Date.now(), data: payload });

    return res.json(payload);

  } catch (error) {
    console.error("[CRITICAL ERROR DURING EXTRACTION]", error);
    return res.status(500).json({
      error: "Imeshindwa kufanya extraction",
      details: error.message,
      fallbackUrl: type === "tv" 
        ? `https://vidsrc-embed.ru/embed/tv/${tmdb_id}/${season}-${episode}`
        : `https://vidsrc-embed.ru/embed/movie/${tmdb_id}`
    });
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error("Error closing browser:", e));
    }
  }
});


/**
 * 2. PROXY ZA "VIDSRC-EMBED.RU" ILI KUEPUKA CORS PROBEMS KWENYE FRONTEND
 * GET /api/latest-movies?page=...
 * GET /api/latest-tvshows?page=...
 * GET /api/latest-episodes?page=...
 */

// A) Latest Movies Proxy
app.get("/api/latest-movies", async (req, res) => {
  const page = req.query.page || 1;
  const targetUrl = `https://vidsrc-embed.ru/movies/latest/page-${page}.json`;
  
  try {
    const fetchResponse = await fetch(targetUrl);
    if (!fetchResponse.ok) throw new Error("Vidsrc API Error");
    const data = await fetchResponse.json();
    return res.json(data);
  } catch (err) {
    console.error(`[Proxy error] Failed fetching latest movies: ${err.message}`);
    return res.status(500).json({ error: "Imeshindwa kupata video mpya kutoka vidsrc-embed.ru" });
  }
});

// B) Latest TV Shows Proxy
app.get("/api/latest-tvshows", async (req, res) => {
  const page = req.query.page || 1;
  const targetUrl = `https://vidsrc-embed.ru/tvshows/latest/page-${page}.json`;
  
  try {
    const fetchResponse = await fetch(targetUrl);
    if (!fetchResponse.ok) throw new Error("Vidsrc API Error");
    const data = await fetchResponse.json();
    return res.json(data);
  } catch (err) {
    console.error(`[Proxy error] Failed fetching latest tvshows: ${err.message}`);
    return res.status(500).json({ error: "Imeshindwa kupata tamthilia mpya kutoka vidsrc-embed.ru" });
  }
});

// C) Latest Episodes Proxy
app.get("/api/latest-episodes", async (req, res) => {
  const page = req.query.page || 1;
  const targetUrl = `https://vidsrc-embed.ru/episodes/latest/page-${page}.json`;
  
  try {
    const fetchResponse = await fetch(targetUrl);
    if (!fetchResponse.ok) throw new Error("Vidsrc API Error");
    const data = await fetchResponse.json();
    return res.json(data);
  } catch (err) {
    console.error(`[Proxy error] Failed fetching latest episodes: ${err.message}`);
    return res.status(500).json({ error: "Imeshindwa kupata vipindi vipya vya mfululizo kutoka vidsrc-embed.ru" });
  }
});

// Server Health check
app.get("/health", (req, res) => {
  res.json({ status: "alive", uptime: process.uptime() });
});

// Listen
app.listen(PORT, "0.0.0.0", () => {
  console.log(`========== RUNNING SCRAPER API ==========`);
  console.log(`Server addresses: http://localhost:${PORT}`);
  console.log(`Endpoint inavyotumiwa: http://localhost:${PORT}/extract?tmdb_id=...&type=movie`);
  console.log(`Latest Movies proxy: http://localhost:${PORT}/api/latest-movies?page=1`);
  console.log(`=========================================`);
});
