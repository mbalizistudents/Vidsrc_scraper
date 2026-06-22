const fetch = require("node-fetch");
const cheerio = require("cheerio");
const AdmZip = require("adm-zip");
const srt2vtt = require("srt-to-vtt");
const { Readable } = require("stream");


const delay = ms =>
new Promise(resolve => setTimeout(resolve, ms));


const randomDelay = (min=2500,max=5500)=>{

const time =
Math.floor(Math.random()*(max-min+1))+min;

console.log(`[SUB] Waiting ${time}ms`);

return delay(time);

};



function buildZipUrl(title){

const clean =
title.replace(/[()]/g,"").trim();


const match =
clean.match(/^(.+?)\s+(\d+x\d+)\s+(.+)$/);


if(!match){

return `https://www.tvsubtitles.net/files/${clean.replace(/\s+/g,"_")}.en.zip`;

}


const [
_,
showName,
episodeCode,
releaseInfo

]=match;


const filename =
`${showName}_${episodeCode}_${releaseInfo}.en.zip`;


return `https://www.tvsubtitles.net/files/${encodeURIComponent(filename)}`;

}





async function searchTVShow(title){

try{


const res =
await fetch(
"https://www.tvsubtitles.net/search.php",
{
method:"POST",
headers:{
"Content-Type":
"application/x-www-form-urlencoded"
},

body:
new URLSearchParams({
qs:title
}).toString()

});


const html =
await res.text();


const $ =
cheerio.load(html);



const link =
$("a[href^='/tvshow-']")
.first()
.attr("href");


if(!link) return null;


return link.match(/tvshow-(\d+)/)?.[1] || null;



}catch(e){

console.log(e.message);

return null;

}

}





async function getEpisodePageId(showId,season,episode){

try{


const url =
`https://www.tvsubtitles.net/tvshow-${showId}-${season}.html`;


const res =
await fetch(url);


const html =
await res.text();


const $ =
cheerio.load(html);


let id=null;


$("table.tableauto tr")
.each((_,row)=>{


const text =
$(row).find("td").first().text().trim();


const match =
text.match(/^(\d+)x(\d+)$/);


if(
match &&
Number(match[1])===Number(season) &&
Number(match[2])===Number(episode)

){


const href =
$(row)
.find("a")
.attr("href");


id =
href?.match(/episode-(\d+)/)?.[1];

}



});


return id;



}catch(e){

return null;

}

}





async function getSubtitleMeta(id){

try{


const res =
await fetch(
`https://www.tvsubtitles.net/episode-${id}-en.html`
);


const html =
await res.text();


const $ =
cheerio.load(html);



const link =
$("a[href^='/subtitle-']").first();


if(!link.length)
return null;


return {

subtitleTitle:
link.text().trim()

};



}catch(e){

return null;

}

}





async function convertToVTT(zipUrl){


try{


const res =
await fetch(zipUrl);


const buffer =
await res.buffer();


const zip =
new AdmZip(buffer);



const file =
zip.getEntries()
.find(x=>x.entryName.endsWith(".srt"));



if(!file)
return null;



const stream =
Readable.from(file.getData());


const vttStream =
stream.pipe(srt2vtt());


let output="";


for await(const chunk of vttStream){

output += chunk;

}


return output;



}catch(e){

return null;

}


}





async function getTVSubtitleVTT(title,season,episode){


console.log(
`[SUB] Processing ${title} S${season}E${episode}`
);



const showId =
await searchTVShow(title);


if(!showId)
return null;


await randomDelay();



const episodeId =
await getEpisodePageId(
showId,
season,
episode
);


if(!episodeId)
return null;



const meta =
await getSubtitleMeta(
episodeId
);


if(!meta)
return null;



const zip =
buildZipUrl(
meta.subtitleTitle
);



return await convertToVTT(zip);



}



module.exports={
getTVSubtitleVTT
};
