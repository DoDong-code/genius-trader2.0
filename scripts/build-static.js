const { spawn } = require('node:child_process');

const viteProcess = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
  stdio: 'inherit'
});

viteProcess.on('error', error => {
  console.error(error);
  process.exit(1);
});

viteProcess.on('close', exitCode => {
  if (exitCode !== 0) process.exit(exitCode || 1);
  require('./copy-static-assets');
  process.exit(0);
});
