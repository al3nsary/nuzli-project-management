/**
 * A12 — installable app and «يُثبَّت مرة واحدة»: install detection (beforeinstallprompt, iOS
 * Safari, standalone), the first-visit card, and the update flow on a mocked workbox-window —
 * waiting → banner → «حدّث الآن» → (wait for an in-flight violation upload) → SKIP_WAITING →
 * controlling → exactly one reload; checks on focus/visibility (throttled) and every 30 minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import {
  CARD_KEY,
  captureInstallEvents,
  detectPlatform,
  installModeOf,
  isIosDevice,
  isIosSafari,
  isStandalone,
  promptInstall,
  useInstallStore,
  type BeforeInstallPromptEvent,
} from './install';
import { InstallCard } from './InstallCard';
import { createUpdater, MIN_CHECK_GAP_MS, UPDATE_INTERVAL_MS, type WorkboxLike } from './updates';
import { usePwaStore } from '../pwaStore';
import { UpdatePrompt } from '../UpdatePrompt';
import { useOfflineStore } from '../../features/violations/offline/runtime';
import { versionLabel } from './version';

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const wrap = (ui: React.ReactNode) => (
  <MantineProvider>
    <MemoryRouter>{ui}</MemoryRouter>
  </MantineProvider>
);

describe('install — platform detection', () => {
  it('tells iPhone Safari, other iOS browsers, iPadOS desktop mode and Android apart', () => {
    expect(isIosDevice({ userAgent: IPHONE_SAFARI })).toBe(true);
    expect(isIosSafari({ userAgent: IPHONE_SAFARI })).toBe(true);
    expect(isIosSafari({ userAgent: IPHONE_CHROME })).toBe(false);
    expect(isIosDevice({ userAgent: IPAD_DESKTOP, maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe(false);
    expect(detectPlatform({ userAgent: ANDROID })).toBe('android');
    expect(detectPlatform({ userAgent: IPHONE_SAFARI })).toBe('ios');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })).toBe('desktop');
  });

  it('standalone: display-mode or navigator.standalone (iOS)', () => {
    const mm = (m: boolean) => () => ({ matches: m }) as MediaQueryList;
    expect(isStandalone({ matchMedia: mm(true), navigator: { userAgent: '' } })).toBe(true);
    expect(isStandalone({ matchMedia: mm(false), navigator: { userAgent: IPHONE_SAFARI, standalone: true } })).toBe(true);
    expect(isStandalone({ matchMedia: mm(false), navigator: { userAgent: IPHONE_SAFARI } })).toBe(false);
  });

  it('the install mode: installed › prompt › iOS guide › manual', () => {
    const e = {} as BeforeInstallPromptEvent;
    expect(installModeOf({ deferred: e, installed: false, standalone: true, platform: 'android' })).toBe('installed');
    expect(installModeOf({ deferred: e, installed: false, standalone: false, platform: 'android' })).toBe('prompt');
    expect(installModeOf({ deferred: null, installed: false, standalone: false, platform: 'ios' })).toBe('ios-guide');
    expect(installModeOf({ deferred: null, installed: false, standalone: false, platform: 'desktop' })).toBe('manual');
  });
});

describe('install — beforeinstallprompt (Android / desktop)', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CARD_KEY);
    useInstallStore.setState({ deferred: null, installed: false, standalone: false, platform: 'android', iosSafari: false, cardDismissed: false });
  });

  it('keeps the event (no mini-infobar), offers «تثبيت التطبيق», and the accepted prompt marks it installed', async () => {
    const stop = captureInstallEvents(window);
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(useInstallStore.getState().deferred).toBe(event);
    render(wrap(<InstallCard />));
    const btn = screen.getByRole('button', { name: 'تثبيت التطبيق' });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(prompt).toHaveBeenCalledOnce();
    expect(useInstallStore.getState().installed).toBe(true);
    expect(screen.queryByTestId('install-card')).toBeNull();
    // The event can be used once.
    expect(await promptInstall()).toBe('unavailable');
    stop();
  });

  it('appinstalled hides every install offer', () => {
    const stop = captureInstallEvents(window);
    act(() => {
      window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'dismissed' }) }));
    });
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(installModeOf(useInstallStore.getState())).toBe('installed');
    stop();
  });
});

describe('install — iPhone', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CARD_KEY);
    useInstallStore.setState({ deferred: null, installed: false, standalone: false, platform: 'ios', iosSafari: true, cardDismissed: false });
  });

  it('the first-visit card links to the «أضف إلى الشاشة الرئيسية» guide; closing it is remembered', () => {
    render(wrap(<InstallCard />));
    expect(screen.getByRole('link', { name: 'أضف إلى الشاشة الرئيسية' })).toHaveAttribute('href', '/install');
    fireEvent.click(screen.getByRole('button', { name: 'إخفاء بطاقة التثبيت' }));
    expect(screen.queryByTestId('install-card')).toBeNull();
    expect(window.localStorage.getItem(CARD_KEY)).toBe('dismissed');
  });

  it('no card when the app already runs from the home screen', () => {
    useInstallStore.setState({ standalone: true });
    render(wrap(<InstallCard />));
    expect(screen.queryByTestId('install-card')).toBeNull();
  });
});

// ---------------------------------------------------------------- updates

class FakeWorkbox implements WorkboxLike {
  handlers: Record<string, ((e: { isUpdate?: boolean }) => void)[]> = {};
  registration = { waiting: null as unknown, installing: null as unknown };
  register = vi.fn(async () => this.registration as unknown as ServiceWorkerRegistration);
  update = vi.fn(async () => undefined);
  messageSkipWaiting = vi.fn(() => undefined);
  addEventListener(type: string, cb: (e: { isUpdate?: boolean }) => void) {
    (this.handlers[type] ??= []).push(cb);
  }
  fire(type: string, e: { isUpdate?: boolean } = {}) {
    for (const h of this.handlers[type] ?? []) h(e);
  }
}

function setup(syncing = false) {
  const wb = new FakeWorkbox();
  const reload = vi.fn();
  let now = 1_000_000;
  let tick: (() => void) | null = null;
  const target = new EventTarget() as EventTarget & { document?: Document };
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  (target as { document?: unknown }).document = doc;
  useOfflineStore.setState({ running: syncing });
  const updater = createUpdater({
    wb,
    reload,
    isSyncing: () => useOfflineStore.getState().running,
    onSyncIdle: (cb) => useOfflineStore.subscribe((s) => !s.running && cb()),
    target: target as unknown as Window,
    now: () => now,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    setTimeout: () => 0,
  });
  return { wb, reload, updater, target, doc, advance: (ms: number) => (now += ms), tick: () => tick?.() };
}

describe('updates — «تحديث متاح — حدّث الآن»', () => {
  beforeEach(() => usePwaStore.setState({ needRefresh: false, status: 'idle', updating: false, waitingForSync: false, update: null, check: null, lastCheckedAt: null }));
  afterEach(() => useOfflineStore.setState({ running: false }));

  it('checks on open, on focus/visibility (at most once a minute) and every 30 minutes', async () => {
    const s = setup();
    await s.updater.start();
    expect(s.wb.register).toHaveBeenCalledOnce();
    s.target.dispatchEvent(new Event('focus'));
    expect(s.wb.update).not.toHaveBeenCalled(); // right after opening: throttled
    s.advance(MIN_CHECK_GAP_MS + 1);
    s.target.dispatchEvent(new Event('focus'));
    s.doc.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(s.wb.update).toHaveBeenCalledTimes(1);
    s.advance(UPDATE_INTERVAL_MS);
    s.tick();
    expect(s.wb.update).toHaveBeenCalledTimes(2);
    s.updater.stop();
  });

  it('a waiting worker shows the persistent banner; «حدّث الآن» → SKIP_WAITING → controlling → one reload', async () => {
    const s = setup();
    await s.updater.start();
    render(wrap(<UpdatePrompt />));
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => s.wb.fire('waiting'));
    expect(screen.getByTestId('update-banner')).toHaveTextContent('تحديث متاح');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'حدّث الآن' }));
    });
    expect(s.wb.messageSkipWaiting).toHaveBeenCalledOnce();
    expect(s.reload).not.toHaveBeenCalled();
    act(() => s.wb.fire('controlling'));
    act(() => s.wb.fire('controlling'));
    expect(s.reload).toHaveBeenCalledTimes(1);
  });

  it('waits for a violation upload in flight before reloading (the outbox is never touched)', async () => {
    const s = setup(true);
    await s.updater.start();
    act(() => s.wb.fire('waiting'));
    render(wrap(<UpdatePrompt />));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'حدّث الآن' }));
    });
    expect(usePwaStore.getState().waitingForSync).toBe(true);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('نُنهي رفع مخالفة');
    expect(s.wb.messageSkipWaiting).not.toHaveBeenCalled();
    await act(async () => {
      useOfflineStore.setState({ running: false });
    });
    expect(s.wb.messageSkipWaiting).toHaveBeenCalledOnce();
    act(() => s.wb.fire('controlling'));
    expect(s.reload).toHaveBeenCalledOnce();
  });

  it('the first install takes control without reloading the page', async () => {
    const s = setup();
    await s.updater.start();
    act(() => s.wb.fire('controlling'));
    expect(s.reload).not.toHaveBeenCalled();
  });

  it('«البحث عن تحديث»: up to date, or available when a new worker is installing', async () => {
    const s = setup();
    await s.updater.start();
    expect(await usePwaStore.getState().check!()).toBe('upToDate');
    expect(usePwaStore.getState().status).toBe('upToDate');
    s.wb.registration.installing = {};
    expect(await usePwaStore.getState().check!()).toBe('available');
    s.wb.update.mockRejectedValueOnce(new Error('offline'));
    s.wb.registration.installing = null;
    expect(await usePwaStore.getState().check!()).toBe('error');
  });

  it('the version label carries the build commit', () => {
    expect(versionLabel('0.2.0', 'abc1234')).toBe('0.2.0 (abc1234)');
    expect(versionLabel('0.2.0', 'local')).toBe('0.2.0');
  });
});
