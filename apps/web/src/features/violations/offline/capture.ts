import { blobToArrayBuffer, stripJpegMetadata } from '../../../lib/bytes';

/** Brief §7.2: longest side about 1600 px, JPEG, about 80 % quality, EXIF stripped. */
export const IMAGE_MAX_SIDE = 1600;
export const IMAGE_QUALITY = 0.8;

/**
 * Compresses a camera photo on the device before it is stored or sent.
 * browser-image-compression redraws the image on a canvas (which drops every EXIF field,
 * GPS included; orientation is applied to the pixels first) and re-encodes it as JPEG.
 * `preserveExif` stays false. Its web worker loads a self-hosted copy of the library
 * (never the CDN default), and the output is passed through `stripJpegMetadata` as a second
 * guarantee — e.g. when the library hands back the original file.
 */
export async function compressImage(file: File | Blob): Promise<Blob> {
  const [{ default: imageCompression }, { default: libURL }] = await Promise.all([
    import('browser-image-compression'),
    import('browser-image-compression/dist/browser-image-compression.js?url'),
  ]);
  const input =
    file instanceof File ? file : new File([file], 'photo.jpg', { type: file.type || 'image/jpeg' });
  const out = await imageCompression(input, {
    maxWidthOrHeight: IMAGE_MAX_SIDE,
    initialQuality: IMAGE_QUALITY,
    fileType: 'image/jpeg',
    preserveExif: false,
    useWebWorker: true,
    libURL: new URL(libURL, window.location.href).href,
  });
  const bytes = stripJpegMetadata(new Uint8Array(await blobToArrayBuffer(out)));
  return new Blob([bytes], { type: 'image/jpeg' });
}

export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'insecure';

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracyM: number;
  at: number;
}

export const GPS_TIMEOUT_MS = 15_000;

/** One high-accuracy fix with a timeout (brief §7.2). Rejects with a `GeoErrorKind`. */
export function getPosition(): Promise<GeoFix> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      reject('insecure' satisfies GeoErrorKind);
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject('unsupported' satisfies GeoErrorKind);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: Math.max(0, pos.coords.accuracy),
          at: pos.timestamp || Date.now(),
        }),
      (err) => {
        const kind: GeoErrorKind =
          err.code === err.PERMISSION_DENIED
            ? 'denied'
            : err.code === err.TIMEOUT
              ? 'timeout'
              : 'unavailable';
        reject(kind);
      },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

/** Device information sent with the violation (the API keeps only these four fields). */
export function deviceInfo(): { userAgent: string; platform: string; online: boolean; appVersion: string } {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const uaData = (nav as Navigator & { userAgentData?: { platform?: string } } | undefined)?.userAgentData;
  return {
    userAgent: (nav?.userAgent ?? '').slice(0, 400),
    platform: (uaData?.platform || nav?.platform || '').slice(0, 80),
    online: nav?.onLine ?? false,
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
  };
}

/** A short human label for the device panel ("Android · Chrome"). */
export function deviceLabel(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /CriOS|Chrome\//.test(ua)
      ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return [os, browser].filter(Boolean).join(' · ');
}
