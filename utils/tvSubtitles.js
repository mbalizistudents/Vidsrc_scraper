// ================================================
// TV SUBTITLES MODULE - Modern Version
// ================================================

import fetch from "node-fetch";
import * as cheerio from "cheerio";
import AdmZip from "adm-zip";
import srt2vtt from "srt-to-vtt";
import { Readable } from "stream";

// Utility: Controlled delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = (min = 2500, max = 5500) => {
  const time = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`[SUB] Waiting ${time}ms...`);
  return delay(time);
};

// Build direct ZIP download URL
const buildZipUrl = (title) => {
  const cleanTitle = title.replace(/[()]/g, "").trim();
  const match = cleanTitle.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);

  if (!match) {
    const fallback = cleanTitle.replace(/\s+/g, "_") + ".en.zip";
    return `https://www.tvsubtitles.net/files/${fallback}`;
  }

  const [, showName, episodeCode, releaseInfo] = match;
  const filename = `\( {showName}_ \){episodeCode}_${releaseInfo}.en.zip`;
  return `https://www.tvsubtitles.net/files/${encodeURIComponent(filename)}`;
};

// Search for TV Show ID
async function searchTVShow(title) {
  try {
    const response = await fetch("https://www.tvsubtitles.net/search.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ qs: title }).toString()
    });

    const html = await response.text();
    const $ = cheerio.load(html);

    const showLink = $("a[href^='/tvshow-']")
      .filter((_, el) => $(el).text().toLowerCase().includes(title.toLowerCase()))
      .first()
      .attr("href");

    if (!showLink) throw new Error("Show not found");

    const match = showLink.match(/tvshow-(\d+)\.html/);
    return match ? match[1] : null;
  } catch (error) {
    console.error("[SUB] Search failed:", error.message);
    return null;
  }
}

// Get Episode Page ID
async function getEpisodePageId(showId, season, episode) {
  try {
    const url = `https://www.tvsubtitles.net/tvshow-\( {showId}- \){season}.html`;
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    let episodeId = null;

    $("table.tableauto tr").each((_, row) => {
      const epCell = $(row).find("td").first().text().trim();
      const match = epCell.match(/^(\d+)x(\d+)$/);

      if (match && parseInt(match[1]) === season && parseInt(match[2]) === episode) {
        const link = $(row).find("td").eq(1).find("a").attr("href");
        const idMatch = link?.match(/episode-(\d+)\.html/);
        if (idMatch) episodeId = idMatch[1];
      }
    });

    return episodeId;
  } catch (error) {
    console.error("[SUB] Episode ID fetch failed:", error.message);
    return null;
  }
}

// Get Subtitle Metadata
async function getSubtitleMeta(episodePageId) {
  try {
    const url = `https://www.tvsubtitles.net/episode-${episodePageId}-en.html`;
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const link = $("a[href^='/subtitle-']").first();
    if (!link.length) return null;

    const subtitleId = link.attr("href")?.match(/subtitle-(\d+)\.html/)?.[1];
    const subtitleTitle = link.find("h5").text().trim();

    return { subtitleId, subtitleTitle };
  } catch (error) {
    console.error("[SUB] Meta fetch failed:", error.message);
    return null;
  }
}

// Convert SRT ZIP to VTT
async function convertZipToVTT(zipUrl) {
  try {
    const response = await fetch(zipUrl);
    if (!response.ok) throw new Error("ZIP download failed");

    const buffer = await response.buffer();
    const zip = new AdmZip(buffer);
    const srtFile = zip.getEntries().find(entry => entry.entryName.endsWith(".srt"));

    if (!srtFile) throw new Error("No SRT file found");

    const srtBuffer = srtFile.getData();
    const srtStream = Readable.from(srtBuffer);
    const vttStream = srtStream.pipe(srt2vtt());

    let vttContent = "";
    for await (const chunk of vttStream) {
      vttContent += chunk;
    }

    console.log("[SUB] Successfully converted to VTT");
    return vttContent;
  } catch (error) {
    console.error("[SUB] Conversion failed:", error.message);
    return null;
  }
}

// ================================================
// MAIN EXPORT
// ================================================
export async function getTVSubtitleVTT(title, season, episode) {
  console.log(`[SUB] Processing: \( {title} - S \){season}E${episode}`);

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
  console.log(`[SUB] ZIP URL: ${zipUrl}`);

  return await convertZipToVTT(zipUrl);
}
