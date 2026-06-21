
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import AdmZip from "adm-zip";
import srt2vtt from "srt-to-vtt";
import { Readable } from "stream";

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = (min = 2500, max = 5500) => {
  const time = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`[SUB] Waiting ${time}ms...`);
  return delay(time);
};

// Build ZIP URL
const buildZipUrl = (title) => {
  const clean = title.replace(/[()]/g, "").trim();
  const match = clean.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);

  if (!match) {
    const fallback = clean.replace(/\s+/g, "_") + ".en.zip";
    return `https://www.tvsubtitles.net/files/${fallback}`;
  }

  const [, showName, episodeCode, releaseInfo] = match;
  const filename = `\( {showName}_ \){episodeCode}_${releaseInfo}.en.zip`;
  return `https://www.tvsubtitles.net/files/${encodeURIComponent(filename)}`;
};

// Search TV Show
async function searchTVShow(title) {
  try {
    const res = await fetch("https://www.tvsubtitles.net/search.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ qs: title }).toString()
    });

    const html = await res.text();
    const $ = cheerio.load(html);

    const link = $("a[href^='/tvshow-']")
      .filter((_, el) => $(el).text().toLowerCase().includes(title.toLowerCase()))
      .first()
      .attr("href");

    if (!link) return null;
    const match = link.match(/tvshow-(\d+)\.html/);
    return match ? match[1] : null;
  } catch (e) {
    console.error("[SUB] Search Error:", e.message);
    return null;
  }
}

// Get Episode Page ID
async function getEpisodePageId(showId, season, episode) {
  try {
    const url = `https://www.tvsubtitles.net/tvshow-\( {showId}- \){season}.html`;
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    let episodeId = null;

    $("table.tableauto tr").each((_, row) => {
      const text = $(row).find("td").first().text().trim();
      const match = text.match(/^(\d+)x(\d+)$/);
      if (match && parseInt(match[1]) === season && parseInt(match[2]) === episode) {
        const link = $(row).find("td").eq(1).find("a").attr("href");
        const idMatch = link?.match(/episode-(\d+)\.html/);
        if (idMatch) episodeId = idMatch[1];
      }
    });

    return episodeId;
  } catch (e) {
    console.error("[SUB] Episode ID Error:", e.message);
    return null;
  }
}

// Get Subtitle Metadata
async function getSubtitleMeta(episodePageId) {
  try {
    const url = `https://www.tvsubtitles.net/episode-${episodePageId}-en.html`;
    const res = await fetch(url);
    const html = await res.text();
    const $ = cheerio.load(html);

    const link = $("a[href^='/subtitle-']").first();
    if (!link.length) return null;

    const subtitleId = link.attr("href")?.match(/subtitle-(\d+)\.html/)?.[1];
    const subtitleTitle = link.find("h5").text().trim();

    return { subtitleId, subtitleTitle };
  } catch (e) {
    console.error("[SUB] Meta Error:", e.message);
    return null;
  }
}

// Convert ZIP to VTT
async function convertToVTT(zipUrl) {
  try {
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error("ZIP download failed");

    const buffer = await res.buffer();
    const zip = new AdmZip(buffer);
    const srtEntry = zip.getEntries().find(e => e.entryName.endsWith(".srt"));

    if (!srtEntry) throw new Error("No SRT file found");

    const srtBuffer = srtEntry.getData();
    const srtStream = Readable.from(srtBuffer);
    const vttStream = srtStream.pipe(srt2vtt());

    let vtt = "";
    for await (const chunk of vttStream) vtt += chunk;

    console.log("[SUB] VTT conversion successful");
    return vtt;
  } catch (e) {
    console.error("[SUB] Conversion Error:", e.message);
    return null;
  }
}

// ===================== MAIN FUNCTION =====================
export async function getTVSubtitleVTT(title, season, episode) {
  console.log(`[SUB] Processing: \( {title} S \){season}E${episode}`);

  const showId = await searchTVShow(title);
  if (!showId) return null;
  await randomDelay();

  const episodeId = await getEpisodePageId(showId, season, episode);
  if (!episodeId) return null;
  await randomDelay();

  const meta = await getSubtitleMeta(episodeId);
  if (!meta) return null;
  await randomDelay();

  const zipUrl = buildZipUrl(meta.subtitleTitle);
  console.log(`[SUB] ZIP: ${zipUrl}`);

  return await convertToVTT(zipUrl);
}
