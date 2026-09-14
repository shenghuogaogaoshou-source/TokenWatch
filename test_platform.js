const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const base = process.argv[2] || 'http://127.0.0.1:8799/';
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#modelRows tr', { timeout: 60000 });
  await page.waitForTimeout(2500);

  const report = {};
  report.autoSrc = await page.locator('#srcSeg button.on').getAttribute('data-src');
  await page.screenshot({ path: OUT + '/p1_default_local.png', fullPage: true });

  // 切到平台侧
  await page.click('#srcSeg button[data-src="platform"]');
  await page.waitForTimeout(1800);
  report.srcAfterClick = await page.locator('#srcSeg button.on').getAttribute('data-src');
  report.srcHint = (await page.locator('#srcHint').textContent() || '').trim();
  report.credState = (await page.locator('#srcCredState').textContent() || '').trim();
  report.platformCards = await page.locator('#platformView .plat-card').count();
  report.platformTitle0 = (await page.locator('#platformView .plat-card h3').first().textContent().catch(() => '')) || '';
  report.tableNote = (await page.locator('#tableNote').textContent() || '').trim();
  report.noRows = (await page.locator('#modelRows tr.no-rows').textContent().catch(() => '')) || '';
  await page.screenshot({ path: OUT + '/p2_platform_guide.png', fullPage: true });

  // 打开凭据弹窗
  await page.click('#btnPlatformCreds');
  await page.waitForTimeout(900);
  report.modals = await page.locator('#platformForm .pf-block').count();
  await page.screenshot({ path: OUT + '/p3_creds_modal.png', fullPage: true });

  // 展开 howto
  const det = page.locator('#platformForm .pf-block').first().locator('details');
  await det.evaluate(d => (d.open = true));
  await page.waitForTimeout(400);

  // 填假 token 并测试
  await page.fill('#pf-deepseek-token', 'eyJhbGciOiJIUzI1NiJ9.fake.fake');
  await page.click('#platformForm .pf-block[data-kind="deepseek"] .pf-acts .btn-ghost');
  await page.waitForTimeout(6000);
  report.testRes = (await page.locator('#platformForm .pf-block[data-kind="deepseek"] .pf-res').textContent() || '').trim();
  report.testResClass = await page.locator('#platformForm .pf-block[data-kind="deepseek"] .pf-res').getAttribute('class');
  await page.screenshot({ path: OUT + '/p4_creds_test.png', fullPage: true });

  // 暗色主题下看平台侧
  await page.click('#btnClosePlatform');
  await page.waitForTimeout(400);
  await page.click('#btnTheme');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/p5_platform_dark.png', fullPage: true });

  report.errs = errs;
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})();
