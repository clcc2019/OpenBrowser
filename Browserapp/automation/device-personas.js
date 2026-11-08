'use strict';

/**
 * Coherent device personas.
 *
 * Sampling each hardware axis independently produces machines that do not exist — 4 cores
 * with 32 GB, a Mac reporting 24-bit colour at 1x, a laptop persona carrying a workstation
 * GPU. Detectors score the *combination*, so an impossible pairing is a stronger signal than
 * any single spoofed value. A persona keeps the axes that co-occur on real hardware bundled
 * together: CPU, memory, GPU, screen geometry, colour depth and pixel ratio ship as one unit.
 *
 * Selection is seeded per profile, so a profile keeps the same persona across launches.
 *
 * GPU strings must match what the OS actually reports: ANGLE/D3D11 on Windows, Metal on
 * macOS, and Mesa/OpenGL on Linux. `webglPresetsForOs` in fingerprint.js holds the same
 * families; these entries pair them with plausible CPU/RAM/display combinations.
 */

/** @typedef {{os:string, cores:number, memory:number, colorDepth:number, devicePixelRatio:number, screen:{width:number,height:number}, webgl:{vendor:string,renderer:string,gpu?:{vendor:string,architecture:string}}}} DevicePersona */

/** @type {DevicePersona[]} */
const WINDOWS_PERSONAS = [
  {
    os: 'windows', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    os: 'windows', cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1366, height: 768 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    os: 'windows', cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'nvidia', architecture: 'ampere' },
    },
  },
  {
    os: 'windows', cores: 16, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'nvidia', architecture: 'ada' },
    },
  },
  {
    os: 'windows', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1.25,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'amd', architecture: 'rdna-2' },
    },
  },
  {
    os: 'windows', cores: 6, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      gpu: { vendor: 'intel', architecture: 'gen-12lp' },
    },
  },
];

/** Apple Silicon hardware: Retina (2x) and 30-bit colour are the norm, not the exception. */
const MACOS_APPLE_PERSONAS = [
  {
    os: 'macos', cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1440, height: 900 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'apple-m1' },
    },
  },
  {
    os: 'macos', cores: 10, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1512, height: 982 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'apple-m2' },
    },
  },
  {
    os: 'macos', cores: 12, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1728, height: 1117 },
    webgl: {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)',
      gpu: { vendor: 'apple', architecture: 'apple-m3' },
    },
  },
];

/**
 * Intel Mac hardware: x86 Chrome builds must not receive an Apple Silicon GPU persona.
 * Keeping this pool separate prevents the UA-CH architecture and WebGL identity from
 * contradicting each other.
 */
const MACOS_INTEL_PERSONAS = [
  {
    os: 'macos', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 2,
    screen: { width: 1680, height: 1050 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    // MacBook Pro 16" (2019): Intel CPU with Radeon Pro 5500M discrete GPU.
    os: 'macos', cores: 8, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 1728, height: 1117 },
    webgl: {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)',
      gpu: { vendor: 'amd', architecture: 'rdna-1' },
    },
  },
  {
    // iMac Pro (2017): Intel Xeon with Radeon Pro Vega 56.
    os: 'macos', cores: 10, memory: 8, colorDepth: 30, devicePixelRatio: 2,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro Vega 56, Unspecified Version)',
      gpu: { vendor: 'amd', architecture: 'vega' },
    },
  },
];

/** Legacy merged pool kept for callers that only need the full macOS set. */
const MACOS_PERSONAS = [...MACOS_APPLE_PERSONAS, ...MACOS_INTEL_PERSONAS];

const LINUX_PERSONAS = [
  {
    os: 'linux', cores: 8, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      gpu: { vendor: 'intel', architecture: 'gen-9' },
    },
  },
  {
    os: 'linux', cores: 12, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 2560, height: 1440 },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)',
      gpu: { vendor: 'nvidia', architecture: 'ampere' },
    },
  },
  {
    os: 'linux', cores: 4, memory: 8, colorDepth: 24, devicePixelRatio: 1,
    screen: { width: 1920, height: 1080 },
    webgl: {
      vendor: 'Google Inc. (AMD)',
      renderer: 'ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir), OpenGL 4.6)',
      gpu: { vendor: 'amd', architecture: 'rdna-2' },
    },
  },
];

/**
 * Fonts shipped with a stock install of each platform. Font probing is one of the strongest
 * OS signals there is — Segoe UI and Calibri only exist on Windows, Helvetica Neue and the
 * SF faces only on macOS — so a profile presenting as one platform while the host is another
 * is contradicted the moment a page enumerates fonts.
 *
 * These lists are deliberately the common baseline rather than an exhaustive dump: claiming
 * an unusually large or exotic font set is itself distinguishing.
 */
const OS_FONTS = Object.freeze({
  windows: Object.freeze([
    'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math', 'Candara',
    'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
    'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free',
    'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode',
    'Malgun Gothic', 'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei',
    'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
    'Microsoft YaHei', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli',
    'Myanmar Text', 'Nirmala UI', 'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print',
    'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ]),
  macos: Object.freeze([
    'American Typewriter', 'Andale Mono', 'Arial', 'Arial Black', 'Arial Narrow',
    'Arial Rounded MT Bold', 'Arial Unicode MS', 'Avenir', 'Avenir Next', 'Avenir Next Condensed',
    'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard',
    'Chalkboard SE', 'Chalkduster', 'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate',
    'Courier', 'Courier New', 'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva',
    'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text',
    'Impact', 'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Microsoft Sans Serif',
    'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'Rockwell',
    'Savoye LET', 'SignPainter', 'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman',
    'Trattatello', 'Trebuchet MS', 'Verdana', 'Zapfino', 'PingFang SC', 'Hiragino Sans',
  ]),
  linux: Object.freeze([
    'Abyssinica SIL', 'Bitstream Charter', 'Cantarell', 'Century Schoolbook L', 'Courier 10 Pitch',
    'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Dingbats', 'FreeMono', 'FreeSans',
    'FreeSerif', 'Liberation Mono', 'Liberation Sans', 'Liberation Sans Narrow',
    'Liberation Serif', 'Nimbus Mono PS', 'Nimbus Roman', 'Nimbus Sans', 'Noto Color Emoji',
    'Noto Mono', 'Noto Sans', 'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Noto Serif',
    'P052', 'Standard Symbols PS', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono', 'URW Bookman',
    'URW Gothic', 'Z003',
  ]),
});

function fontsForOs(os) {
  const family = String(os || '').toLowerCase();
  if (family.startsWith('macos') || family === 'darwin') return OS_FONTS.macos;
  if (family === 'linux') return OS_FONTS.linux;
  return OS_FONTS.windows;
}

/**
 * Families that exist on exactly one platform. Used to answer font probes for a persona:
 * claiming Windows while the host answers "yes" to Helvetica Neue is a direct contradiction.
 */
function exclusiveFontsForOtherOs(os) {
  const family = String(os || '').toLowerCase();
  const isMac = family.startsWith('macos') || family === 'darwin';
  const isLinux = family === 'linux';
  const mine = new Set(fontsForOs(os).map((name) => name.toLowerCase()));
  const others = [];
  for (const [key, list] of Object.entries(OS_FONTS)) {
    const keyIsMac = key === 'macos';
    const keyIsLinux = key === 'linux';
    if ((isMac && keyIsMac) || (isLinux && keyIsLinux) || (!isMac && !isLinux && key === 'windows')) continue;
    for (const name of list) if (!mine.has(name.toLowerCase())) others.push(name);
  }
  return others;
}

const PERSONAS_BY_OS = Object.freeze({
  windows: Object.freeze(WINDOWS_PERSONAS),
  macos: Object.freeze(MACOS_INTEL_PERSONAS),
  macos_arm: Object.freeze(MACOS_APPLE_PERSONAS),
  linux: Object.freeze(LINUX_PERSONAS),
});

// Versioned pools keep existing profiles tied to the original modulo and ordering.
// Each added entry is a plausible bundle, not a claim of a measured real device.
function extraPersona(os, cores, width, height, ratio, depth, vendor, renderer, gpuVendor, architecture) {
  return { os, cores, memory: 8, colorDepth: depth, devicePixelRatio: ratio,
    screen: { width, height }, webgl: { vendor, renderer, gpu: { vendor: gpuVendor, architecture } } };
}
const EXTRA_PERSONAS = {
  windows: [],
  macos: [
    extraPersona('macos', 8, 1440, 900, 2, 30, 'Google Inc. (Intel)', 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 640, Unspecified Version)', 'intel', 'gen-9'),
    extraPersona('macos', 8, 1680, 1050, 2, 30, 'Google Inc. (AMD)', 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 560X, Unspecified Version)', 'amd', 'polaris'),
    extraPersona('macos', 8, 1440, 900, 2, 24, 'Google Inc. (Intel)', 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 645, Unspecified Version)', 'intel', 'gen-9'),
    extraPersona('macos', 8, 1680, 1050, 2, 30, 'Google Inc. (AMD)', 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5300M, Unspecified Version)', 'amd', 'rdna-1'),
  ],
  macos_arm: [
    extraPersona('macos', 8, 1470, 956, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'apple', 'apple-m2'),
    extraPersona('macos', 8, 1470, 956, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', 'apple', 'apple-m3'),
    extraPersona('macos', 10, 1512, 982, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)', 'apple', 'apple-m4'),
    extraPersona('macos', 8, 1440, 900, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)', 'apple', 'apple-m1'),
    extraPersona('macos', 10, 1512, 982, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', 'apple', 'apple-m1'),
    extraPersona('macos', 12, 1728, 1117, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', 'apple', 'apple-m2'),
    extraPersona('macos', 10, 1512, 982, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)', 'apple', 'apple-m3'),
    extraPersona('macos', 12, 1728, 1117, 2, 30, 'Google Inc. (Apple)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)', 'apple', 'apple-m4'),
  ],
  linux: [
    extraPersona('linux', 8, 1920, 1080, 1, 24, 'Google Inc. (Intel)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)', 'intel', 'gen-9'),
    extraPersona('linux', 12, 1920, 1080, 1, 24, 'Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060/PCIe/SSE2, OpenGL 4.6)', 'nvidia', 'ada'),
    extraPersona('linux', 16, 2560, 1440, 1, 24, 'Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navi23), OpenGL 4.6)', 'amd', 'rdna-2'),
  ],
};
const PERSONAS_V2_BY_OS = Object.freeze(Object.fromEntries(Object.entries(PERSONAS_BY_OS)
  .map(([os, pool]) => [os, Object.freeze([...pool, ...EXTRA_PERSONAS[os]])])));

// Common logical display sizes, including scaled Retina and external displays. These
// describe machine/display combinations, not independently sampled physical devices.
const MAC_DISPLAY_SIZES = Object.freeze([
  [1280, 720], [1280, 800], [1440, 900], [1470, 956], [1512, 982],
  [1680, 1050], [1728, 1117], [1920, 1080], [1920, 1200], [2560, 1440],
]);
function macDisplayVariants(pool) {
  const result = [];
  const seen = new Set();
  for (const persona of pool) {
    const key = JSON.stringify(persona);
    if (!seen.has(key)) { seen.add(key); result.push(persona); }
  }
  for (const persona of pool) {
    for (const [width, height] of MAC_DISPLAY_SIZES) {
      const variant = { ...persona, screen: { width, height } };
      const key = JSON.stringify(variant);
      if (!seen.has(key)) { seen.add(key); result.push(variant); }
    }
  }
  return Object.freeze(result);
}
const PERSONAS_V3_BY_OS = Object.freeze({
  ...PERSONAS_V2_BY_OS,
  macos: macDisplayVariants(PERSONAS_V2_BY_OS.macos),
  macos_arm: macDisplayVariants(PERSONAS_V2_BY_OS.macos_arm),
});

// CPU counts and GPU families are kept together; display variants do not imply
// these are measurements collected from physical devices.
function applePersona(chip, cores, width, height, family) {
  return extraPersona('macos', cores, width, height, 2, 30, 'Google Inc. (Apple)',
    `ANGLE (Apple, ANGLE Metal Renderer: Apple ${chip}, Unspecified Version)`, 'apple', `apple-${family}`);
}
const MAC_V4_INTEL = [
  extraPersona('macos', 4, 1440, 900, 2, 24, 'Google Inc. (Intel)', 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 640, Unspecified Version)', 'intel', 'gen-9'),
  extraPersona('macos', 8, 1680, 1050, 2, 30, 'Google Inc. (Intel)', 'ANGLE (Intel, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version)', 'intel', 'gen-9'),
  extraPersona('macos', 12, 1680, 1050, 2, 30, 'Google Inc. (AMD)', 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5300M, Unspecified Version)', 'amd', 'rdna-1'),
  extraPersona('macos', 16, 1680, 1050, 2, 30, 'Google Inc. (AMD)', 'ANGLE (AMD, ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)', 'amd', 'rdna-1'),
];
const MAC_V4_APPLE = [
  applePersona('M1 Pro', 8, 1512, 982, 'm1'),
  applePersona('M1 Max', 10, 1728, 1117, 'm1'),
  applePersona('M2 Pro', 10, 1512, 982, 'm2'),
  applePersona('M2 Max', 12, 1728, 1117, 'm2'),
  applePersona('M3 Pro', 11, 1512, 982, 'm3'),
  applePersona('M3 Max', 14, 1728, 1117, 'm3'),
  applePersona('M3 Max', 16, 1728, 1117, 'm3'),
  applePersona('M4', 10, 1470, 956, 'm4'),
  applePersona('M4 Pro', 14, 1512, 982, 'm4'),
  applePersona('M4 Max', 14, 1728, 1117, 'm4'),
  applePersona('M4 Max', 16, 1728, 1117, 'm4'),
];
const PERSONAS_V4_BY_OS = Object.freeze({
  ...PERSONAS_V3_BY_OS,
  macos: macDisplayVariants([...PERSONAS_V2_BY_OS.macos, ...MAC_V4_INTEL]),
  macos_arm: macDisplayVariants([...PERSONAS_V2_BY_OS.macos_arm, ...MAC_V4_APPLE]),
});

// Apple specifications checked 2026-11-06; see docs/mac-persona-sources.md.
// Renderer labels follow our existing ANGLE convention and are not field measurements.
const MAC_V5_APPLE = [
  applePersona('M5', 10, 1280, 832, 'm5'),
  applePersona('M5 Pro', 15, 1512, 982, 'm5'),
  applePersona('M5 Pro', 18, 1512, 982, 'm5'),
  applePersona('M5 Max', 18, 1728, 1117, 'm5'),
  applePersona('M6', 10, 2240, 1260, 'm6'),
  applePersona('M6', 12, 1512, 982, 'm6'),
];
const PERSONAS_V5_BY_OS = Object.freeze({
  ...PERSONAS_V4_BY_OS,
  macos_arm: macDisplayVariants([...PERSONAS_V4_BY_OS.macos_arm, ...MAC_V5_APPLE]),
});

function personasForOs(os, version = 1) {
  const pools = Number(version) === 5 ? PERSONAS_V5_BY_OS : (Number(version) === 4 ? PERSONAS_V4_BY_OS : (Number(version) === 3 ? PERSONAS_V3_BY_OS : (Number(version) === 2 ? PERSONAS_V2_BY_OS : PERSONAS_BY_OS)));
  return pools[String(os || '').toLowerCase()] || pools.windows;
}

/**
 * Deterministically pick one persona for an OS. `index` should come from the profile seed so
 * the same profile keeps the same hardware identity on every launch.
 * @returns {DevicePersona}
 */
function pickPersona(os, index, version = 1) {
  const pool = personasForOs(os, version);
  const n = Number.isFinite(Number(index)) ? Math.abs(Math.trunc(Number(index))) : 0;
  return pool[n % pool.length];
}

/** True when the axes form a combination that real hardware actually ships. */
function isCoherent(persona) {
  if (!persona) return false;
  const { cores, memory, colorDepth, devicePixelRatio, os, webgl } = persona;
  if (!Number.isInteger(cores) || cores < 2 || cores > 64) return false;
  if (!Number.isInteger(memory) || memory < 4 || memory > 8) return false;
  // Memory tracks core count on real machines: no 4-core/32 GB or 16-core/4 GB laptops.
  if (cores <= 4 && memory > 16) return false;
  if (cores >= 12 && memory < 8) return false;
  if (![24, 30].includes(colorDepth)) return false;
  if (!(devicePixelRatio >= 1 && devicePixelRatio <= 3)) return false;
  // Apple ships Retina panels; a 1x Mac persona would stand out.
  if (String(os).startsWith('macos') && devicePixelRatio < 2) return false;
  // GPU strings must match the platform's graphics backend.
  const renderer = String(webgl?.renderer || '');
  if (os === 'windows' && !/D3D11/.test(renderer)) return false;
  if (String(os).startsWith('macos') && !/Metal/.test(renderer)) return false;
  if (os === 'linux' && !/OpenGL/.test(renderer)) return false;
  return true;
}

module.exports = {
  WINDOWS_PERSONAS,
  MACOS_PERSONAS,
  MACOS_APPLE_PERSONAS,
  MACOS_INTEL_PERSONAS,
  PERSONAS_BY_OS,
  PERSONAS_V2_BY_OS,
  PERSONAS_V3_BY_OS,
  PERSONAS_V4_BY_OS,
  PERSONAS_V5_BY_OS,
  OS_FONTS,
  personasForOs,
  pickPersona,
  isCoherent,
  fontsForOs,
  exclusiveFontsForOtherOs,
};
