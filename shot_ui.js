const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const out = path.join(__dirname, 'shots');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1480, height: 1000 },
    deviceScaleFactor: 2,
  });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const base = process.argv[2] || 'http://127.0.0.1:8733/';
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#modelRows tr', { timeout: 60000 });
  await page.waitForTimeout(5000);

  await page.screenshot({ path: out + '/ui_1_provider.png', fullPage: true });

  const modelBtn = page.locator('#viewSeg button[data-view="model"]');
  if (await modelBtn.count()) {
    await modelBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: out + '/ui_2_model.png', fullPage: true });
  } else {
    errs.push('viewSeg button not found');
  }

  await page.click('#btnTheme');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out + '/ui_3_dark.png', fullPage: true });

  const rows = await page.locator('#modelRows tr').count();
  const note = await page.locator('#tableNote').textContent();
  const legend = await page.locator('#legend').textContent();
  const tape = await page.locator('#tapeBalanceV').textContent();

  console.log(JSON.stringify({ rows, note, legend, tape, errs }, null, 2));
  await browser.close();
})();
