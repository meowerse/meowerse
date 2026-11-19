import { chromium } from "@playwright/test";
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1440,height:900}});
p.on("console", m=>console.log("C:", m.type(), m.text().slice(0,200))); p.on("pageerror", e=>console.log("PE:", String(e).slice(0,300)));
await p.route(/\/_astro\/client\.[^/]*\.js$/, r=>r.abort());
await p.goto("http://127.0.0.1:4456/ui/components/modal/");
const sh = p.locator(".demo-stage [data-demo]"); await sh.evaluate(e=>e.scrollIntoView({block:"center"}));
await p.waitForTimeout(13000);
console.log(await sh.evaluate(e=>e.outerHTML.slice(0,200)+"\n----\n"+e.querySelector("[data-demo-wait]")?.outerHTML+"\nisland:"+e.querySelector("astro-island")?.outerHTML.slice(0,300)));
await b.close();
