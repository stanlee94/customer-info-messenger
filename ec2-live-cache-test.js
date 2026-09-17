const { chromium } = require('/Users/stanleemok/Documents/Personal/claude-code/temporary/ocbcsg/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const EXT = '/Users/stanleemok/Documents/Personal/claude-code/chrome-extension/customer-info-messenger';
const ENVF = '/Users/stanleemok/Documents/Personal/claude-code/ec2-login/lambda/.env';
for (const l of fs.readFileSync(ENVF,'utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^["']|["']$/g,''); }
const UA='Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
async function ec2Cookie(){const url=process.env.BASEROW_URL.replace(/\/+$/,'')+`/api/database/rows/table/${process.env.BASEROW_TABLE_ID}/?user_field_names=true&size=200`;const r=await fetch(url,{headers:{Authorization:'Token '+process.env.BASEROW_TOKEN,'User-Agent':UA}});const j=await r.json();return String((j.results||[]).find(x=>String(x.Name)==='EC2').Value||'');}
const LIVE='https://ec2.full2house.com/Ent/index.php?live_id=' + (process.env.TONIGHT || '556923') + '&a=EntLive&m=liveingManager';

(async()=>{
  const cookieStr=await ec2Cookie();
  const dir=path.join(__dirname,'chrome-profile-ttl'); fs.rmSync(dir,{recursive:true,force:true});
  const ctx=await chromium.launchPersistentContext(dir,{channel:'chromium',headless:true,
    args:[`--disable-extensions-except=${EXT}`,`--load-extension=${EXT}`],viewport:{width:1440,height:900}});

  let hits=0; ctx.on('request',r=>{ if(r.url().includes('/api/database/rows/table/749/')) hits++; });

  let [sw]=ctx.serviceWorkers(); if(!sw) sw=await ctx.waitForEvent('serviceworker',{timeout:20000});
  const extId=new URL(sw.url()).host;
  const opt=await ctx.newPage(); await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.evaluate(cfg=>new Promise(r=>chrome.storage.local.set(cfg,r)),{ ec2LiveEnabled: true,
    baserowBaseUrl:process.env.BASEROW_URL.replace(/\/+$/,''),baserowToken:process.env.BASEROW_TOKEN,
    baserowUsersTableId:'749',baserowOrdersTableId:'750'});
  await opt.evaluate(async () => { for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts({ ids: ['ec2-live'] })).length; i++) await new Promise((r) => setTimeout(r, 100)); }); // overlay is opt-in

  await ctx.addCookies(cookieStr.split(';').map(p=>{const i=p.indexOf('=');return{name:p.slice(0,i).trim(),value:p.slice(i+1).trim(),domain:'ec2.full2house.com',path:'/'};}).filter(c=>c.name));

  const page=await ctx.newPage();
  const load=async(label)=>{ hits=0; await page.goto(LIVE,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForSelector('.ddr-card',{timeout:60000}); await page.waitForTimeout(16000);
    const cards=await page.evaluate(()=>document.querySelectorAll('.ddr-card').length);
    console.log(`  ${label.padEnd(34)} baserow requests: ${String(hits).padStart(3)}   cards: ${cards}`); return hits; };

  const cacheStats=async()=>opt.evaluate(()=>new Promise(res=>chrome.storage.local.get(null,all=>{
    const keys=Object.keys(all).filter(k=>k.startsWith('rfm:'));
    const withVal=keys.filter(k=>all[k].v).length;
    res({entries:keys.length,positive:withVal,negative:keys.length-withVal});
  })));

  // age every cached entry by N days
  const ageBy=async(days)=>opt.evaluate((d)=>new Promise(res=>chrome.storage.local.get(null,all=>{
    const patch={}; Object.keys(all).filter(k=>k.startsWith('rfm:')).forEach(k=>{
      patch[k]={v:all[k].v,t:all[k].t-d*86400000};});
    chrome.storage.local.set(patch,()=>res(Object.keys(patch).length));
  })),days);

  console.log('=== CACHE LIFECYCLE ===');
  await load('1. cold (empty cache)');
  console.log('   cache now:', JSON.stringify(await cacheStats()));
  await load('2. same day (cache warm)');
  const aged = await ageBy(1);
  console.log(`   -- aged ${aged} entries by 1 day (simulating tomorrow) --`);
  const after = await load('3. next day (cache stale)');
  console.log('   cache now:', JSON.stringify(await cacheStats()));
  console.log('\n' + (after > 0 ? 'PASS: stale entries were refetched' : 'FAIL: stale cache was reused'));

  await ctx.close();
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
