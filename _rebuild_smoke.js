const esbuild = require('C:/Users/Administrator/Desktop/Codex3/genius-trader2.0/node_modules/esbuild');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe';
const ROOT = 'C:/Users/Administrator/Desktop/Codex3/genius-trader2.0';
const entry = path.join(ROOT, 'src/services/ai/index.ts');
const out = path.join(ROOT, 'server/services/ai/index.js');

(async () => {
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'info' });
  console.log('BUILD OK ->', out);

  // node --check
  execFileSync(NODE, ['--check', out], { stdio: 'inherit' });
  console.log('node --check OK');

  // smoke test with mocked global fetch
  const smoke = `
    global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      summary: '测试账户今日总体观望，个别半导体仓位过重可择机减。',
      operations: [
        { fundCode: 'F0001', action: '适量减仓', reason: '仓位过重逢高减' },
        { fundCode: 'F0002', action: '继续持有', reason: '长期逻辑 intact' },
        { fundCode: 'F0003', action: '暂不操作', reason: '观望' }
      ]
    }) }] }) });
    const ai = require(${JSON.stringify(out)});
    (async () => {
      const r = await ai.analyzePortfolio(
        { account: '默认账户', strategies: ['核心：科技'], holdings: [
          { code:'F0001', name:'基金1', amount:2000, cost:1900, profit:100, profitRate:0.05, todayEstimate:-0.01, direction:'科技' },
          { code:'F0002', name:'基金2', amount:2000, cost:1900, profit:100, profitRate:0.05, todayEstimate:-0.01, direction:'科技' },
          { code:'F0003', name:'基金3', amount:2000, cost:1900, profit:100, profitRate:0.05, todayEstimate:-0.01, direction:'科技' }
        ] },
        { provider:'OpenAI', model:'gpt-5-mini', apiKey:'x' }
      );
      console.log('healthScore=', r.healthScore, 'riskScore=', r.riskScore);
      console.log('suggestions=', JSON.stringify(r.suggestions.map(s=>({code:s.code,action:s.action,reason:s.reason}))));
      console.log('summary=', r.summary);
      if (r.suggestions.length !== 3) { console.error('FAIL: expected 3 suggestions'); process.exit(2); }
      if (r.healthScore !== null || r.riskScore !== null) { console.error('FAIL: scores not null'); process.exit(3); }
      console.log('SMOKE PASS');
    })().catch(e => { console.error('SMOKE ERR', e); process.exit(1); });
  `;
  fs.writeFileSync(path.join(ROOT, '_smoke2.js'), smoke);
  execFileSync(NODE, [path.join(ROOT, '_smoke2.js')], { stdio: 'inherit' });
  fs.unlinkSync(path.join(ROOT, '_smoke2.js'));
})().catch(e => { console.error('BUILD/SMOKE ERR', e); process.exit(1); });
