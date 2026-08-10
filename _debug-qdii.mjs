import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const sample = {
  accounts: {
    '主账户': {
      name: '主账户',
      funds: [
        { code: '013309', name: '\u6613\u65b9\u8fbe\u6052\u751f\u79d1\u6280ETF\u8054\u63a5(QDII)C', amount: 100000, today: 0, hold: 0.1, category: '\u6df7\u5408', transactions: [] }
      ],
      strategy: [],
      closedPositions: []
    }
  },
  active: '主账户'
};

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await context.newPage();
await page.addInitScript((data) => { localStorage.setItem('genius-trader-portfolio-v2', JSON.stringify(data)); }, sample);
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded', timeout: 20000 });
await page.click('[data-view="portfolio"]');
await page.waitForTimeout(9000);

const report = await page.evaluate(() => {
  const state = window.portfolioState;
  const account = state.accounts[state.getActive()];
  const fund = (account && account.funds || []).find((f) => f.code === '013309');
  const name = fund ? fund.name : '(none)';
  const hk = /\u6052\u751f|\u6e2f\u80a1|\u6e2f\u7f8e/.test(String(name));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date());
  const row = document.querySelector('.fund-row[data-code="013309"]');
  const badge = row && row.querySelector('.nav-updated-badge, .nav-estimate-badge');
  return { name, hk, shanghaiToday: today, weekday: wd, badge: badge ? badge.textContent.trim() : '(none)' };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
