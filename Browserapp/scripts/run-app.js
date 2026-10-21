#!/usr/bin/env node
/**
 * Dev launcher: fully brand host bundle, then start OpenBrowser.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findHostLinuxBinary,
  findMacBinary,
} = require('./resolve-host-dist.js');
const { ensureHostRuntime } = require('./ensure-host-runtime.js');

const appRoot = path.resolve(__dirname, '..');

// Never start as root: Electron appData would become /var/root/... and split
// profile/fingerprint config from the normal user UI (~/Library/...).
function assertNonRootDevUser() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const isRoot = uid === 0 || euid === 0 || process.env.USER === 'root' || process.env.LOGNAME === 'root';
  if (!isRoot) return;
  const hintUser = process.env.SUDO_USER || process.env.USER || 'your-user';
  console.error([
    '[run] refuse to start OpenBrowser as root/sudo.',
    '      Root writes userData to /var/root/Library/Application Support/openbrowser',
    '      while the UI you edit lives under ~/Library/Application Support/openbrowser.',
    `      Start as a normal user, e.g.: sudo -u ${hintUser} -H npm start`,
    `      home now would be: ${os.homedir()}`,
  ].join('\n'));
  process.exit(2);
}

assertNonRootDevUser();
ensureHostRuntime(appRoot);

if (process.platform === 'darwin') {
  // Must brand BEFORE resolving binary (renames Electron.app -> OpenBrowser.app).
  require('./brand-host-dev.js');
}

function resolveHostBinary() {
  if (process.platform === 'darwin') {
    const distRoot = resolveHostDist(appRoot);
    const appBundle = findHostAppBundle(distRoot);
    const binary = findMacBinary(path.join(appBundle, 'Contents', 'MacOS'));
    if (fs.existsSync(binary)) return binary;
  }

  if (process.platform === 'win32') {
    try {
      const binary = require('desktop-shell');
      if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
    } catch (_) { /* fall through */ }
    const distRoot = resolveHostDist(appRoot);
    const binary = findHostWindowsExe(distRoot);
    if (fs.existsSync(binary)) return binary;
  }

  if (process.platform === 'linux') {
    try {
      const binary = require('desktop-shell');
      if (typeof binary === 'string' && fs.existsSync(binary)) return binary;
    } catch (_) { /* fall through */ }
    const distRoot = resolveHostDist(appRoot);
    const binary = findHostLinuxBinary(distRoot);
    if (fs.existsSync(binary)) return binary;
  }

  throw new Error('缺少当前平台的应用运行环境。请在 Browserapp 目录执行 npm install --force --include=dev。');
}

function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

const hostBin = resolveHostBinary();
let launchBin = hostBin;
let launchArgs = [appRoot];

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  const xvfbRun = findExecutable('xvfb-run');
  const xvfb = findExecutable('Xvfb');
  if (!xvfbRun || !xvfb) {
    console.error([
      '[run] no graphical session found (DISPLAY and WAYLAND_DISPLAY are unset),',
      '      and Xvfb is unavailable.',
      '      Start from an X11/Wayland desktop session, or install xvfb and xauth.',
    ].join('\n'));
    process.exit(1);
  }
  launchBin = xvfbRun;
  launchArgs = ['-a', hostBin, appRoot];
  console.log('[run] no graphical session found; using a virtual X display');
}

console.log('[run] starting', hostBin);

const child = spawn(launchBin, launchArgs, {
  stdio: 'inherit',
  env: process.env,
  cwd: appRoot,
});

let childClosed = false;
let childSpawnFailed = false;
let receivedSignal = null;
let forwardedSignal = null;

function forwardSignal(signal) {
  if (childClosed) return;
  if (!receivedSignal) receivedSignal = signal;
  if (!child.pid || forwardedSignal) return;
  forwardedSignal = signal;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      try { child.kill(signal); } catch (_) {}
    }
  }
}

const forwardedSignals = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM']
  : ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of forwardedSignals) process.on(signal, () => forwardSignal(signal));

child.once('spawn', () => {
  if (receivedSignal) forwardSignal(receivedSignal);
});

child.on('error', (error) => {
  childSpawnFailed = true;
  console.error('[run] failed to start application:', error.message);
});

child.on('close', (code, signal) => {
  childClosed = true;
  if (receivedSignal) {
    const signalNumber = os.constants.signals?.[receivedSignal];
    process.exitCode = signalNumber ? 128 + signalNumber : 1;
  } else if (signal) {
    const signalNumber = os.constants.signals?.[signal];
    process.exitCode = signalNumber ? 128 + signalNumber : 1;
  } else {
    process.exitCode = childSpawnFailed ? 1 : (code == null ? 1 : code);
  }
});
