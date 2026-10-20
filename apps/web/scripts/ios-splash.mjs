/**
 * A12: the iPhone launch screens (apple-touch-startup-image), portrait, in CSS points × scale.
 * One list, read by scripts/make-app-images.mjs (draws public/splash/*.png) and by vite.config.ts
 * (injects the <link> tags with the right media query and base path).
 */
export const IOS_SPLASH = [
  { w: 320, h: 568, r: 2, devices: 'iPhone SE (1st)' },
  { w: 375, h: 667, r: 2, devices: 'iPhone SE (2nd/3rd), 8, 7, 6s' },
  { w: 414, h: 736, r: 3, devices: 'iPhone 8 Plus, 7 Plus' },
  { w: 375, h: 812, r: 3, devices: 'iPhone X, XS, 11 Pro, 12 mini, 13 mini' },
  { w: 414, h: 896, r: 2, devices: 'iPhone XR, 11' },
  { w: 414, h: 896, r: 3, devices: 'iPhone XS Max, 11 Pro Max' },
  { w: 390, h: 844, r: 3, devices: 'iPhone 12, 13, 14, 12 Pro, 13 Pro' },
  { w: 428, h: 926, r: 3, devices: 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus' },
  { w: 393, h: 852, r: 3, devices: 'iPhone 14 Pro, 15, 15 Pro, 16' },
  { w: 430, h: 932, r: 3, devices: 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus' },
  { w: 402, h: 874, r: 3, devices: 'iPhone 16 Pro, 17, 17 Pro' },
  { w: 440, h: 956, r: 3, devices: 'iPhone 16 Pro Max, 17 Pro Max' },
];

export const splashFile = (s) => `splash/apple-splash-${s.w * s.r}x${s.h * s.r}.png`;

export const splashMedia = (s) =>
  `(device-width: ${s.w}px) and (device-height: ${s.h}px) and (-webkit-device-pixel-ratio: ${s.r}) and (orientation: portrait)`;
