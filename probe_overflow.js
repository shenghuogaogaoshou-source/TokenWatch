const { chromium } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8733';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1220, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(base, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1500);

  const info = await p.evaluate(() => {
    const out = {};
    out.tape = [...document.querySelectorAll('.tape-item')].map(el => {
      const v = el.querySelector('.tape-val') || el.querySelector('.tape-value') || el.querySelector('b,strong,span');
      const r = el.getBoundingClientRect();
      return {
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        w: Math.round(r.width),
        scrollW: el.scrollWidth,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
    });
    // 找出所有横向溢出的元素
    out.overflowing = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden') {
          out.overflowing.push({
            cls: el.className && el.className.toString().slice(0, 40),
            tag: el.tagName,
            text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
            cw: el.clientWidth, sw: el.scrollWidth,
          });
        }
      }
    });
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})();
