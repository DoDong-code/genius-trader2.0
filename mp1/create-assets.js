const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'images', 'tabs');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// Minimal transparent 1x1 PNG image hex representation
const transparentPngHex = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789ccb62f80f0006000301361518f40000000049454e44ae426082';
const buffer = Buffer.from(transparentPngHex, 'hex');

const icons = [
  'overview.png',
  'overview_active.png',
  'portfolio.png',
  'portfolio_active.png',
  'analysis.png',
  'analysis_active.png',
  'setting.png',
  'setting_active.png'
];

icons.forEach(iconName => {
  const filePath = path.join(dir, iconName);
  fs.writeFileSync(filePath, buffer);
  console.log(`Created asset placeholder: ${filePath}`);
});
