const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({headless:true});
  const ctx = await b.newContext({viewport:{width:1440,height:900}});
  await ctx.addCookies([{name:'lc_token',value:'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjb2xsZWN0aW9uSWQiOiJfcGJfdXNlcnNfYXV0aF8iLCJleHAiOjE3NzQ2MzI2NzgsImlkIjoicXo5cG8zNTJhOTVqMjRzIiwicHJvamVjdElkIjoibHVtaWNoYXQiLCJyZWZyZXNoYWJsZSI6dHJ1ZSwidHlwZSI6ImF1dGgifQ.Dre-lauNE7-4L6DbBxix875XvUKDTdxcZubtCsoZJnY',domain:'localhost',path:'/'}]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:9471/lumichat', {waitUntil:'networkidle', timeout:20000});
  await page.waitForTimeout(3000);
  await page.screenshot({path:'tests/screenshots/ui-audit-full.png', fullPage:false});
  
  const checks = await page.evaluate(() => {
    const r = {};
    const fi = document.querySelector('#file-in');
    r.fileInputVisible = fi ? (fi.offsetWidth > 2 && fi.offsetHeight > 2) : false;
    const sa = document.querySelector('#splash-accent');
    r.splashColor = sa ? getComputedStyle(sa).color : 'gone';
    r.bodyFont = getComputedStyle(document.body).fontFamily.slice(0,50);
    const caps = document.querySelectorAll('.cap-icon');
    r.capCount = caps.length;
    const chips = document.querySelectorAll('.file-chip');
    r.chipCount = chips.length;
    r.sidebarVisible = !!document.querySelector('#sidebar');
    r.headerVisible = !!document.querySelector('#header');
    r.msgInputVisible = !!document.querySelector('#msg-in');
    return r;
  });
  console.log(JSON.stringify(checks, null, 2));
  await b.close();
})().catch(e => console.error(e.message));
