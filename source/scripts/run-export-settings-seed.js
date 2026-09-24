'use strict';

const { spawn } = require('child_process');
const path = require('path');

const child = spawn(
  process.execPath,
  [path.join(__dirname, 'run-electron.js'), '--export-settings-seed', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: process.env
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
