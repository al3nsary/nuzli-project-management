import { create } from 'zustand';

/*
 * A12 — «قابلًا للتحميل على الجوال الآيفون والأندرويد والتثبيت عليهم كتطبيق».
 *
 * Android and desktop Chromium fire `beforeinstallprompt`: we keep the event and offer our own
 * «تثبيت التطبيق» button (in «المزيد», the profile and a dismissible first-visit card).
 * iPhone and iPad have no such event: Safari installs from Share → «إضافة إلى الشاشة الرئيسية»,
 * so we detect iOS that is not already standalone and open the step-by-step guide (/install).
 * The capture runs before React renders (main.tsx), so an early event is never missed.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

export type InstallPlatform = 'ios' | 'android' | 'desktop';
/** What the install UI should offer on this device right now. */
export type InstallMode = 'installed' | 'prompt' | 'ios-guide' | 'manual';

interface NavLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
}

/** iPhone, iPod, or an iPad (iPadOS 13+ says «Macintosh» but has a touch screen). */
export function isIosDevice(nav: NavLike): boolean {
  const ua = nav.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Safari itself (not an in-app browser such as Instagram, nor Chrome/Firefox/Edge for iOS, whose
 * share sheets name the action differently). The guide still opens elsewhere, with a note to open
 * the link in Safari.
 */
export function isIosSafari(nav: NavLike): boolean {
  if (!isIosDevice(nav)) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\/|Twitter|Snapchat|TikTok/i.test(nav.userAgent);
}

export function detectPlatform(nav: NavLike): InstallPlatform {
  if (isIosDevice(nav)) return 'ios';
  if (/Android/i.test(nav.userAgent)) return 'android';
  return 'desktop';
}

/** Running as the installed app (home-screen icon) rather than in a browser tab. */
export function isStandalone(win: Pick<Window, 'matchMedia'> & { navigator: NavLike }): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true;
    if (win.matchMedia?.('(display-mode: fullscreen)').matches) return true;
  } catch {
    /* old engines */
  }
  return win.navigator.standalone === true;
}

interface InstallState {
  deferred: BeforeInstallPromptEvent | null;
  installed: boolean;
  standalone: boolean;
  platform: InstallPlatform;
  iosSafari: boolean;
  /** The first-visit card was closed on this device. */
  cardDismissed: boolean;
  set(patch: Partial<InstallState>): void;
}

export const CARD_KEY = 'nz.install.card';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(CARD_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export const useInstallStore = create<InstallState>((set) => ({
  deferred: null,
  installed: false,
  standalone: false,
  platform: 'desktop',
  iosSafari: false,
  cardDismissed: false,
  set: (patch) => set(patch),
}));

export function installModeOf(s: Pick<InstallState, 'deferred' | 'installed' | 'standalone' | 'platform'>): InstallMode {
  if (s.standalone || s.installed) return 'installed';
  if (s.deferred) return 'prompt';
  if (s.platform === 'ios') return 'ios-guide';
  return 'manual';
}

export function useInstallMode(): InstallMode {
  return useInstallStore(installModeOf);
}

/** Starts listening; returns the cleanup. Safe to call more than once (tests). */
export function captureInstallEvents(win: Window = window): () => void {
  const nav = win.navigator as Navigator & NavLike;
  useInstallStore.getState().set({
    platform: detectPlatform(nav),
    iosSafari: isIosSafari(nav),
    standalone: isStandalone(win as unknown as Pick<Window, 'matchMedia'> & { navigator: NavLike }),
    cardDismissed: readDismissed(),
  });
  const onPrompt = (e: Event) => {
    // Keep the browser's mini-infobar away; our button and card offer the install instead.
    e.preventDefault();
    useInstallStore.getState().set({ deferred: e as BeforeInstallPromptEvent });
  };
  const onInstalled = () => useInstallStore.getState().set({ installed: true, deferred: null });
  win.addEventListener('beforeinstallprompt', onPrompt);
  win.addEventListener('appinstalled', onInstalled);
  let mq: MediaQueryList | null = null;
  const onMode = () => useInstallStore.getState().set({ standalone: isStandalone(win as unknown as Pick<Window, 'matchMedia'> & { navigator: NavLike }) });
  try {
    mq = win.matchMedia?.('(display-mode: standalone)') ?? null;
    mq?.addEventListener?.('change', onMode);
  } catch {
    mq = null;
  }
  return () => {
    win.removeEventListener('beforeinstallprompt', onPrompt);
    win.removeEventListener('appinstalled', onInstalled);
    mq?.removeEventListener?.('change', onMode);
  };
}

/** Shows the browser's install dialog (Android / desktop). The event can be used once. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const { deferred, set } = useInstallStore.getState();
  if (!deferred) return 'unavailable';
  set({ deferred: null });
  try {
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === 'accepted') set({ installed: true });
    return choice.outcome;
  } catch {
    return 'dismissed';
  }
}

export function dismissInstallCard() {
  try {
    window.localStorage.setItem(CARD_KEY, 'dismissed');
  } catch {
    /* storage blocked: the card just comes back next visit */
  }
  useInstallStore.getState().set({ cardDismissed: true });
}
