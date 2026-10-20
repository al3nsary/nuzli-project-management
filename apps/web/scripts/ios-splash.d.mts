export interface IosSplash {
  w: number;
  h: number;
  r: number;
  devices: string;
}
export const IOS_SPLASH: IosSplash[];
export function splashFile(s: IosSplash): string;
export function splashMedia(s: IosSplash): string;
