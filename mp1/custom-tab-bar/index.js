// custom-tab-bar/index.js
// 设计原则（v9）：App 全局唯一实验模式状态，所有 custom-tab-bar 实例共享。
// storage = 持久化真值；App.globalData.experimentalMode = 当前运行时唯一状态；
// 每个 custom-tab-bar 实例在 attached 时注册到 globalData.tabBarInstances，
// 长按切换时 applyExperimentalMode 广播给所有已注册实例，彻底消除多实例状态漂移。
const FULL_LIST = [
  { pagePath: '/pages/index/index', text: '总览', icon: 'overview' },
  { pagePath: '/pages/portfolio/portfolio', text: '持仓', icon: 'portfolio' },
  { pagePath: '/pages/analysis/analysis', text: '分析', icon: 'analysis' },
  { pagePath: '/pages/setting/setting', text: '设置', icon: 'setting' }
];

// 纯函数：只根据传入的 enabled 计算，绝不读 this.data / 其他实例状态。
// 始终返回 4 项，仅给「分析」项打 hidden 标记（关闭时隐藏）。仅在初始化 / 真正切换模式时调用。
function buildList(enabled) {
  return FULL_LIST.map(item => ({
    ...item,
    hidden: item.pagePath === '/pages/analysis/analysis' && !enabled
  }));
}

Component({
  data: {
    selected: 0,
    color: '#86868b',
    selectedColor: '#0071e3',
    list: buildList(false),
    experimentalOn: false
  },
  // attached 读取全局唯一状态并注册本实例；detached 注销，防止持有已销毁实例。
  lifetimes: {
    attached() {
      const app = getApp();
      let enabled;
      if (app.globalData && typeof app.globalData.experimentalMode === 'boolean') {
        enabled = app.globalData.experimentalMode;
      } else {
        enabled = Boolean(wx.getStorageSync('experimentalMode'));
        if (app.globalData) {
          app.globalData.experimentalMode = enabled;
        }
      }
      // 注册当前实例到全局实例表（仅 attached 注册，不在页面 onShow 注册）
      if (app.globalData) {
        if (!Array.isArray(app.globalData.tabBarInstances)) {
          app.globalData.tabBarInstances = [];
        }
        if (!app.globalData.tabBarInstances.includes(this)) {
          app.globalData.tabBarInstances.push(this);
        }
      }
      this.setData({ experimentalOn: enabled, list: buildList(enabled) });
      console.log('[TAB attached]', {
        experimentalMode: enabled,
        experimentalOn: enabled
      });
    },
    detached() {
      const app = getApp();
      if (!app.globalData || !Array.isArray(app.globalData.tabBarInstances)) {
        return;
      }
      app.globalData.tabBarInstances =
        app.globalData.tabBarInstances.filter(instance => instance !== this);
    }
  },
  methods: {
    // 唯一允许改变显隐状态的地方：长按设置 tab 真正切换实验模式时调用。
    // 写 storage → 更新全局唯一状态 → 广播给所有已注册实例同步 experimentalOn + list。
    applyExperimentalMode(enabled) {
      const on = Boolean(enabled);
      const app = getApp();
      // 1. 持久化
      wx.setStorageSync('experimentalMode', on);
      // 2. 更新全局唯一状态
      if (app.globalData) {
        app.globalData.experimentalMode = on;
      }
      // 3. 广播给所有已经存在的 custom-tab-bar 实例
      const instances =
        app.globalData && Array.isArray(app.globalData.tabBarInstances)
          ? app.globalData.tabBarInstances.slice()
          : [];
      instances.forEach(instance => {
        if (!instance) return;
        instance.setData({ experimentalOn: on, list: buildList(on) });
      });
      console.log('[TAB applyExperimentalMode]', {
        enabled: on,
        instanceCount: instances.length
      });
    },
    // 高亮当前页面对应 tab：只改 selected，绝不读 storage / buildList / 动 experimentalOn / 动 list。
    highlight(pagePath) {
      const idx = this.data.list.findIndex(item => item.pagePath === pagePath);
      if (idx < 0 || idx === this.data.selected) {
        return;
      }
      this.setData({ selected: idx });
      console.log('[TAB highlight]', {
        pagePath,
        selected: idx
      });
    },
    // 点击 tab：只在「点击分析」时读一次全局状态做权限拦截（隐藏时不可进入）。
    // 绝对不因读状态而 setData / buildList / 改 experimentalOn / 改 list。
    switchTab(e) {
      const path = e.currentTarget.dataset.path;
      if (path === '/pages/setting/setting') {
        // 快速点击 6 次触发隐藏实验开关
        const now = Date.now();
        if (!this._clickHistory) this._clickHistory = [];
        this._clickHistory.push(now);
        // 仅保留 3 秒内的点击记录
        this._clickHistory = this._clickHistory.filter(t => now - t < 3000);
        if (this._clickHistory.length >= 6) {
          this._clickHistory = []; // 重置计数
          const app = getApp();
          const current =
            app.globalData && typeof app.globalData.experimentalMode === 'boolean'
              ? app.globalData.experimentalMode
              : Boolean(wx.getStorageSync('experimentalMode'));
          this.applyExperimentalMode(!current);
          wx.showToast({
            title: !current ? '已开启实验功能' : '已关闭实验功能',
            icon: 'none'
          });
        }
      }
      if (path === '/pages/analysis/analysis') {
        const app = getApp();
        const on =
          app.globalData && typeof app.globalData.experimentalMode === 'boolean'
            ? app.globalData.experimentalMode
            : Boolean(wx.getStorageSync('experimentalMode'));
        if (!on) {
          return;
        }
      }
      console.log('[TAB switchTab]', { path });
      wx.switchTab({ url: path });
    },
    // 长按「设置」tab 6 秒，切换实验功能开关（再次长按可关闭）；静默，无进度条。
    // storage 写入统一交给 applyExperimentalMode，避免重复写；本方法只负责「取反全局状态 + 触发广播」。
    onTabTouchStart(e) {
      if (e.currentTarget.dataset.path !== '/pages/setting/setting') {
        return;
      }
      this._lpTimer = setTimeout(() => {
        this._lpTimer = null;
        const app = getApp();
        const current =
          app.globalData && typeof app.globalData.experimentalMode === 'boolean'
            ? app.globalData.experimentalMode
            : Boolean(wx.getStorageSync('experimentalMode'));
        this.applyExperimentalMode(!current);
        wx.showToast({
          title: !current ? '已开启实验功能' : '已关闭实验功能',
          icon: 'none'
        });
      }, 6000);
    },
    onTabTouchEnd() {
      if (this._lpTimer) {
        clearTimeout(this._lpTimer);
        this._lpTimer = null;
      }
    }
  }
});
