// app.js
import { initCloud } from './utils/request.js';

App({
  globalData: {
    accounts: {},
    activeAccountName: '主账户',
    shanghaiToday: ''
  },

  onLaunch() {
    // 1. Initialize WeChat Cloud Development if supported
    initCloud();

    // 2. Initialize timezone-adjusted dates (Asia/Shanghai)
    this.initDate();

    // 3. Load or restore state
    this.loadState();
  },

  initDate() {
    const formatTwo = n => String(n).padStart(2, '0');
    // Compute Shanghai Date (UTC+8)
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const shanghaiTime = new Date(utc + 3600000 * 8);
    const y = shanghaiTime.getFullYear();
    const m = formatTwo(shanghaiTime.getMonth() + 1);
    const d = formatTwo(shanghaiTime.getDate());
    this.globalData.shanghaiToday = `${y}-${m}-${d}`;
    console.log('[App] Date Initialized (Shanghai Timezone):', this.globalData.shanghaiToday);
  },

  loadState() {
    const storageKey = 'genius-trader-portfolio-v2';
    try {
      const saved = wx.getStorageSync(storageKey);
      if (saved && saved.accounts && typeof saved.accounts === 'object') {
        this.globalData.accounts = saved.accounts;
        this.globalData.activeAccountName = saved.active || Object.keys(saved.accounts)[0] || '主账户';
        console.log('[App] State restored from LocalStorage.');
        return;
      }
    } catch (e) {
      console.warn('[App] LocalStorage restore failed:', e);
    }

    // Default Fallback Accounts
    console.log('[App] Loading default mock accounts.');
    this.globalData.accounts = {
      '主账户': {
        name: '主账户',
        portfolioDataVersion: '20260731-account2-corrected-v2',
        snapshotDate: '2026-07-30',
        strategy: [
          '降低重复持仓',
          '银行已退出，沪深 300 作为核心宽基',
          '科技成长长期看好但控制仓位',
          '半导体观察并维持低仓位',
          '黄金作为防守资产',
          '债券作为组合稳定器'
        ],
        closedPositions: [
          {
            name: '天弘中证银行ETF联接C',
            code: '001595',
            closedBefore: '2026-07-30',
            reason: ['连涨一个月', '持仓收益约+5%', '与沪深300存在重叠', '精简组合']
          }
        ],
        funds: [
          {
            name: '国泰半导体设备ETF联接C',
            code: '019633',
            category: '权益类',
            amount: 10000,
            holdingProfit: 520,
            holdingRate: 0.052,
            hold: 0.052,
            today: -0.015,
            todayEstimate: -150,
            manualToday: -0.015,
            manualEstimateDate: '2026-07-31',
            manualEstimateUnavailable: false,
            notes: ['芯片板块示例'],
            holdings: [
              { stock_code: '600584', stock_name: '长电科技', weight: 0.083 },
              { stock_code: '603986', stock_name: '兆易创新', weight: 0.078 },
              { stock_code: '002371', stock_name: '北方华创', weight: 0.064 }
            ],
            transactionVersion: 2,
            transactions: [
              { type: 'buy', amount: 10000, fee: 0, date: '2026-07-13' }
            ]
          },
          {
            name: '华夏黄金ETF联接C',
            code: '008702',
            category: '黄金类',
            amount: 15000,
            holdingProfit: 1860,
            holdingRate: 0.124,
            hold: 0.124,
            today: 0.008,
            todayEstimate: 120,
            manualToday: 0.008,
            manualEstimateDate: '2026-07-31',
            manualEstimateUnavailable: false,
            notes: ['避险资产示例'],
            holdings: [
              { stock_code: 'AU9999', stock_name: '黄金现货', weight: 0.924 },
              { stock_code: 'CASH', stock_name: '现金及其他', weight: 0.076 }
            ],
            transactionVersion: 2,
            transactions: [
              { type: 'buy', amount: 15000, fee: 0, date: '2026-07-05' }
            ]
          }
        ]
      },
      '创新星账户': {
        name: '创新星账户',
        portfolioDataVersion: '20260731-account2-corrected-v2',
        snapshotDate: '2026-07-30',
        strategy: ['专注于高成长、高科技及海外资产，追求阿尔法超额收益'],
        closedPositions: [],
        funds: [
          {
            name: '易方达恒生科技ETF联接(QDII)C',
            code: '013309',
            category: '海外类',
            amount: 8000,
            holdingProfit: 640,
            holdingRate: 0.08,
            hold: 0.08,
            today: 0.012,
            todayEstimate: 96,
            manualToday: 0.012,
            manualEstimateDate: '2026-07-31',
            manualEstimateUnavailable: false,
            notes: ['港股互联网科技'],
            holdings: [
              { stock_code: 'TENCENT', stock_name: '腾讯控股', weight: 0.08 },
              { stock_code: 'ALIBABA', stock_name: '阿里巴巴-W', weight: 0.08 },
              { stock_code: 'MEITUAN', stock_name: '美团-W', weight: 0.08 }
            ],
            transactionVersion: 2,
            transactions: [
              { type: 'buy', amount: 8000, fee: 0, date: '2026-07-20' }
            ]
          }
        ]
      }
    };
    this.saveState();
  },

  saveState() {
    const storageKey = 'genius-trader-portfolio-v2';
    try {
      wx.setStorageSync(storageKey, {
        accounts: this.globalData.accounts,
        active: this.globalData.activeAccountName
      });
      console.log('[App] State persisted successfully.');
    } catch (e) {
      console.error('[App] State persistence failed:', e);
    }
  },

  // Helper getters/setters
  getActiveAccount() {
    return this.globalData.accounts[this.globalData.activeAccountName] || { name: '未知账户', funds: [] };
  },

  setActiveAccount(name) {
    if (this.globalData.accounts[name]) {
      this.globalData.activeAccountName = name;
      this.saveState();
      return true;
    }
    return false;
  },

  addAccount(name) {
    if (!name || this.globalData.accounts[name]) return false;
    this.globalData.accounts[name] = {
      name: name,
      portfolioDataVersion: '20260731-account2-corrected-v2',
      snapshotDate: this.globalData.shanghaiToday,
      strategy: [],
      closedPositions: [],
      funds: []
    };
    this.saveState();
    return true;
  },

  deleteAccount(name) {
    if (this.globalData.accounts[name]) {
      delete this.globalData.accounts[name];
      if (this.globalData.activeAccountName === name) {
        this.globalData.activeAccountName = Object.keys(this.globalData.accounts)[0] || '';
      }
      this.saveState();
      return true;
    }
    return false;
  },

  addFund(accountName, fund) {
    const account = this.globalData.accounts[accountName];
    if (!account) return false;
    if (!account.funds) account.funds = [];
    
    // Check if fund already exists
    const exists = account.funds.find(f => f.code === fund.code);
    if (exists) return false;

    account.funds.push(fund);
    this.saveState();
    return true;
  },

  deleteFund(accountName, fundCode) {
    const account = this.globalData.accounts[accountName];
    if (!account) return false;
    if (!account.funds) return false;

    const index = account.funds.findIndex(f => f.code === fundCode);
    if (index !== -1) {
      account.funds.splice(index, 1);
      this.saveState();
      return true;
    }
    return false;
  }
});
