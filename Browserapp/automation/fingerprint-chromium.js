'use strict';

const CURRENT_VERSION = '150.0.7871.186';
const RELEASES_API = 'https://api.github.com/repos/adryfish/fingerprint-chromium/releases/latest';
const TAG_RE = /^\d+\.\d+\.\d+\.\d+$/;
const SHA256_RE = /^sha256:([0-9a-f]{64})$/i;

const PINNED_RELEASE = Object.freeze({
  version: CURRENT_VERSION,
  publishedAt: '2026-10-02T14:02:29Z',
  assets: Object.freeze([
    Object.freeze({
      name: `ungoogled-chromium-${CURRENT_VERSION}-1-x86_64_linux.tar.xz`,
      url: `https://github.com/adryfish/fingerprint-chromium/releases/download/${CURRENT_VERSION}/ungoogled-chromium-${CURRENT_VERSION}-1-x86_64_linux.tar.xz`,
      digest: 'sha256:48eff860053efd9ad498d51370f0a1f59f983df39c02a72ad2a8682cdead4055',
      size: 145806232,
    }),
    Object.freeze({
      name: `ungoogled-chromium_${CURRENT_VERSION}-1.1_windows_x64.zip`,
      url: `https://github.com/adryfish/fingerprint-chromium/releases/download/${CURRENT_VERSION}/ungoogled-chromium_${CURRENT_VERSION}-1.1_windows_x64.zip`,
      digest: 'sha256:4d549c326e51ebbabf562fd365eb5380d9d4a81200da2c60f075c688d9a77e03',
      size: 193743241,
    }),
  ]),
});

function fingerprintPlatformKey(platform = process.platform, arch = process.arch) {
  if (!['linux', 'win32', 'darwin'].includes(platform)) return '';
  if (!['x64', 'arm64'].includes(arch)) return '';
  return `${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'}-${arch}`;
}

function sha256Digest(value) {
  const match = SHA256_RE.exec(String(value || '').trim());
  return match ? match[1].toLowerCase() : '';
}

function normalizeFingerprintRelease(value = {}) {
  const version = String(value.tag_name || value.version || '').trim();
  if (!TAG_RE.test(version)) throw new Error('Fingerprint Chromium release tag is invalid');
  const sourceAssets = Array.isArray(value.assets) ? value.assets : [];
  const assets = sourceAssets.map((asset) => {
    const name = String(asset?.name || '').trim();
    const url = String(asset?.browser_download_url || asset?.url || '').trim();
    const digest = String(asset?.digest || '').trim();
    const size = Number(asset?.size) || 0;
    if (!name || !/^https:\/\/github\.com\/adryfish\/fingerprint-chromium\/releases\/download\//i.test(url)) {
      throw new Error(`Fingerprint Chromium asset is invalid: ${name || 'unknown'}`);
    }
    if (!sha256Digest(digest)) throw new Error(`Fingerprint Chromium asset has no SHA-256 digest: ${name}`);
    if (size < 0) throw new Error(`Fingerprint Chromium asset has invalid size: ${name}`);
    return { name, url, digest, size };
  });
  if (!assets.length) throw new Error('Fingerprint Chromium release has no assets');
  return {
    version,
    publishedAt: String(value.published_at || value.publishedAt || ''),
    assets,
  };
}

function selectFingerprintAsset(release, platform = process.platform, arch = process.arch) {
  const key = fingerprintPlatformKey(platform, arch);
  if (!key) return null;
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (key === 'linux-x64') {
    return assets.find((asset) => /(?:x86_64.*linux|linux.*x86_64).*\.tar\.xz$/i.test(asset.name)) || null;
  }
  if (key === 'windows-x64') {
    return assets.find((asset) => /windows.*x64.*\.zip$/i.test(asset.name)) || null;
  }
  if (key === 'macos-arm64') {
    return assets.find((asset) => /macos.*(?:arm64|aarch64).*\.dmg$/i.test(asset.name))
      || assets.find((asset) => /macos.*\.dmg$/i.test(asset.name) && !/x64|intel/i.test(asset.name))
      || null;
  }
  if (key === 'macos-x64') {
    return assets.find((asset) => /macos.*x64.*\.dmg$/i.test(asset.name))
      || assets.find((asset) => /macos.*intel.*\.dmg$/i.test(asset.name))
      || null;
  }
  return null;
}

module.exports = {
  CURRENT_VERSION,
  RELEASES_API,
  PINNED_RELEASE,
  fingerprintPlatformKey,
  normalizeFingerprintRelease,
  selectFingerprintAsset,
  sha256Digest,
};
