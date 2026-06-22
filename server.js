const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;


// ================= MIDDLEWARE =================

app.set("trust proxy", 1);

app.use(cors({
  origin:"*"
}));

app.use(express.json());



const limiter = rateLimit({

windowMs:15 * 60 * 1000,

max:300,

message:{
error:"Too many requests"
}

});


app.use("/extract", limiter);




// ================= PLAYWRIGHT =================


let chromium = null;
let browserInstance = null;


try{

chromium = require("playwright").chromium;


}catch(e){

console.log(
"Playwright missing"
);

}




async function getBrowser(){


if(!chromium){

return null;

}



if(
!browserInstance ||
!browserInstance.isConnected()

){


console.log(
"Launching chromium..."
);



browserInstance =
await chromium.launch({

headless:true,


args:[

"--no-sandbox",

"--disable-setuid-sandbox",

"--disable-dev-shm-usage",

"--disable-gpu",

"--single-process",

"--no-zygote"

]


});


}



return browserInstance;


}





// ================= CACHE =================


const cache = new Map();


function makeKey(
id,
type,
season,
episode
){

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





const key =
makeKey(
tmdb_id,
type,
season,
episode
);



if(cache.has(key)){


return res.json(
cache.get(key)
);


}





const fallback =

type==="tv"

?

`https://vidsrc-embed.ru/embed/tv/${tmdb_id}/${season}-${episode}`

:

`https://vidsrc-embed.ru/embed/movie/${tmdb_id}`;




let streamUrl = null;



let browser =
await getBrowser();



if(browser){



let context = null;



try{


context =
await browser.newContext({

ignoreHTTPSErrors:true,


userAgent:

"Mozilla/5.0 Chrome"


});



const page =
await context.newPage();



page.on(
"request",
request=>{


const url =
request.url();



if(

url.includes(".m3u8")

||

url.includes(".mp4")

){


console.log(
"STREAM FOUND:",
url
);


streamUrl = url;


}



});






let target;



if(type==="tv"){


target =

`https://vidsrcme.ru/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}`;



}else{


target =

`https://vidsrcme.ru/embed/movie/${tmdb_id}`;


}





console.log(
"Opening:",
target
);



await page.goto(

target,

{

waitUntil:"domcontentloaded",

timeout:15000

}

);



await page.waitForTimeout(4000);





}catch(e){


console.log(

"SCRAPER ERROR:",

e.message

);



}

finally{


if(context){


await context.close()
.catch(()=>{});


}



}



}






const result = {


tmdb_id,

type,


streamUrl:
streamUrl || fallback,


source:
streamUrl
?
"playwright"
:
"fallback",


time:
new Date()

};




cache.set(
key,
result
);



return res.json(result);



});







// ================= HEALTH =================



app.get("/health",(req,res)=>{


res.json({

status:"online",

uptime:
process.uptime()

});


});






// ================= START =================


app.listen(

PORT,

"0.0.0.0",

()=>{


console.log(
`SERVER RUNNING ON ${PORT}`
);


});





// ================= SHUTDOWN =================


process.on(
"SIGTERM",

async()=>{


console.log(
"Shutdown signal received"
);



if(browserInstance){


await browserInstance.close()
.catch(()=>{});


}



process.exit(0);


});
