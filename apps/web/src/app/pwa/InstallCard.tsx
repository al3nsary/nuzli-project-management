import { Link } from 'react-router-dom';
import { IconDeviceMobileDown, IconX } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { t } from '../../i18n';
import { dismissInstallCard, promptInstall, useInstallMode, useInstallStore } from './install';

/**
 * The first-visit install card (A12): on a device that can install (Android/desktop prompt, or
 * iPhone/iPad Safari) and is not already running the installed app. Closing it is remembered on
 * this device; the install stays available in «المزيد».
 */
export function InstallCard() {
  const mode = useInstallMode();
  const dismissed = useInstallStore((s) => s.cardDismissed);
  if (dismissed || (mode !== 'prompt' && mode !== 'ios-guide')) return null;
  return (
    <aside className="nz-install-card" aria-label={t('install.cardTitle')} data-testid="install-card">
      <span className="nz-install-ic" aria-hidden>
        <IconDeviceMobileDown size={22} stroke={1.7} />
      </span>
      <span className="nz-install-text">
        <b>{t('install.cardTitle')}</b>
        <span>{t('install.cardBody')}</span>
      </span>
      {mode === 'prompt' ? (
        <button
          type="button"
          className="nz-install-btn"
          onClick={async () => {
            const r = await promptInstall();
            if (r === 'accepted') notifications.show({ color: 'ok', message: t('install.accepted') });
          }}
        >
          {t('install.button')}
        </button>
      ) : (
        <Link to="/install" className="nz-install-btn">
          {t('install.iosButton')}
        </Link>
      )}
      <button type="button" className="nz-install-x" onClick={dismissInstallCard} aria-label={t('install.cardDismiss')}>
        <IconX size={16} stroke={2} aria-hidden />
      </button>
    </aside>
  );
}
