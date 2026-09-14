const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'shots');

function scanScript(tag) {
  return () => {
    const out = { overflowing: [], clipped: [] };
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden') {
          out.overflowing.push({
            cls: (el.className || '').toString().slice(0, 46),
            tag: el.tagName,
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            cw: el.clientWidth, sw: el.scrollWidth,
          });
        }
      }
    });
    // 垂直方向被裁的关键文案（单行元素高度明显小于 scrollHeight）
    document.querySelectorAll('.pc-sub,.pc-note,.strip-src,.src-hint,.src-credstate,.pf-meta,.pf-label,.q-cap,.pc-pill,.pf-res').forEach(el => {
      if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
        out.clipped.push({ cls: el.className, text: (el.innerText || '').slice(0, 50), ch: el.clientHeight, sh: el.scrollHeight });
      }
    });
    return out;
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1220, height: 900 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  const base = process.argv[2] || 'http://127.0.0.1:8799/';
  await page.goto(base, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('#modelRows tr', { timeout: 60000 });
  await page.waitForTimeout(2500);

  const res = {};
  res.local = await page.evaluate(scanScript('local'));

  await page.click('#srcSeg button[data-src="platform"]');
  await page.waitForTimeout(1500);
  res.platform = await page.evaluate(scanScript('platform'));
  await page.screenshot({ path: OUT + '/a1_platform_1220.png', fullPage: true });

  await page.setViewportSize({ width: 1480, height: 1000 });
  await page.waitForTimeout(600);
  await page.click('#btnPlatformCreds');
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/a2_modal_vp.png' });           // 仅视口
  res.modal = await page.evaluate(scanScript('modal'));

  // 窄屏检查
  await page.click('#btnClosePlatform');
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(700);
  res.narrow = await page.evaluate(scanScript('narrow'));
  await page.screenshot({ path: OUT + '/a3_narrow_900.png', fullPage: true });

  res.errs = errs;
  console.log(JSON.stringify(res, null, 2));
  await browser.close();
})();
