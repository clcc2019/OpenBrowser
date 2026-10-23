'use strict';

/**
 * Native Wayland cannot create a Vulkan surface in Chromium. Disable Vulkan for
 * that backend so Electron/browser kernels use their compatible GL path instead
 * of logging a startup error and retrying GPU initialization.
 */
function disableVulkanOnWayland(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'linux') return false;
  const sessionType = String(env?.XDG_SESSION_TYPE || '').trim().toLowerCase();
  return sessionType === 'wayland' || Boolean(String(env?.WAYLAND_DISPLAY || '').trim());
}

module.exports = { disableVulkanOnWayland };
