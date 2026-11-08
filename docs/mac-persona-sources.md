# Mac persona source notes

Checked 2026-11-06. Version 5 adds configurations based on Apple's published specifications:

- [MacBook Air specifications](https://www.apple.com/macbook-air/specs/): M5 with 10 CPU cores and a 2560 × 1664 native 13-inch display.
- [MacBook Pro specifications](https://www.apple.com/macbook-pro/specs/): M5 Pro with 15 or 18 CPU cores, M5 Max with 18 CPU cores, and M6 with 12 CPU cores; the 14-inch display has a 3024 × 1964 native resolution.
- [iMac specifications](https://www.apple.com/imac/specs/): M6 with 10 or 12 CPU cores and a 4480 × 2520 native display. The product was listed for preorder when checked.

Template sizes are logical browser coordinates, not necessarily the panel's physical pixel count. Additional screen sizes model scaling or external displays; they are not separate physical models. Browser deviceMemory is a quantized reported value, not installed RAM.

Apple's hardware specifications do not establish Chrome/ANGLE renderer strings, WebGPU architecture values, browser-reported screen sizes, or User-Agent Client Hints. The renderer names and platform-version defaults in these templates follow the project's existing conventions and require testing on actual devices. Explicit user overrides take precedence. Older template versions remain unchanged.
