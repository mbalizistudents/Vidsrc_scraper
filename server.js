const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(cors({ origin: "*" }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
});

app.use("/extract", limiter);


// ================= PLAYWRIGHT SAFE LOADER =================

let chromium = null;
let browserInstance = null;

try {
  chromium = require("playwright").chromium;
} catch {
  console.log("Playwright missing - using fallback mode");
}


async function getBrowser() {

  if (!chromium) return null;

  if (!browserInstance) {

    browserInstance = await chromium.launch({
      headless: true,
      args:[
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote"
      ]
    });

    console.log("Browser started");
  }


  return browserInstance;
}



// ================= CACHE =================

const cache = new Map();

function cacheKey(id,type,season,episode){

 return `${id}-${type}-${season}-${episode}`;

}



// ================= EXTRACT =================


app.get("/extract", async(req,res)=>{


const {
 tmdb_id,
 type,
 season,
 episode

}=req.query;



if(!tmdb_id || !type){

return res.status(400).json({
error:"tmdb_id and type required"
});

}



const key = cacheKey(
tmdb_id,
type,
season,
episode
);



if(cache.has(key)){

return res.json(cache.get(key));

}



const fallback = type==="tv"

?

`https://vidsrc-embed.ru/embed/tv/${tmdb_id}/${season}-${episode}`

:

`https://vidsrc-embed.ru/embed/movie/${tmdb_id}`;



// If no playwright

const browser = await getBrowser();


if(!browser){


const data={

tmdb_id,
type,
streamUrl:fallback,
source:"fallback",
timestamp:new Date()

};


cache.set(key,data);

return res.json(data);


}




let stream=null;



try{


const page = await browser.newPage();


page.on("request",req=>{


const url=req.url();


if(

url.includes(".m3u8")

||

url.includes(".mp4")

){

stream=url;

console.log(
"STREAM FOUND",
url
);

}


});



let target;


if(type==="tv"){

target=
`https://vidsrcme.ru/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}`;


}else{


target=
`https://vidsrcme.ru/embed/movie/${tmdb_id}`;


}




await page.goto(
target,
{
waitUntil:"domcontentloaded",
timeout:15000
}
);


await page.waitForTimeout(4000);


await page.close();



}catch(e){


console.log(
"SCRAPER ERROR",
e.message
);


}




const result={

tmdb_id,

type,

streamUrl:stream || fallback,

source:stream ? "sniffer":"fallback",

timestamp:new Date()

};



cache.set(key,result);


res.json(result);



});



// ================= FEEDS =================


app.get("/health",(req,res)=>{


res.json({

status:"online",

time:new Date(),

uptime:process.uptime()

});


});



// ================= START =================


app.listen(
PORT,
"0.0.0.0",
()=>{


console.log(
`SERVER RUNNING PORT ${PORT}`
);


});


// graceful shutdown

process.on("SIGTERM",async()=>{

console.log("Closing server");

if(browserInstance){

await browserInstance.close();

}

process.exit(0);

});
