import { Loader } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { usePwaStore } from './pwaStore';
import { t } from '../i18n';

/**
 * «تحديث متاح — حدّث الآن» (A12): a persistent banner while a new version waits. It stays until
 * the user updates (the update also stays available in «المزيد»). Pressing it waits for any
 * violation upload in flight, then reloads once into the new version.
 */
export function UpdatePrompt() {
  const needRefresh = usePwaStore((s) => s.needRefresh);
  const updating = usePwaStore((s) => s.updating);
  const waitingForSync = usePwaStore((s) => s.waitingForSync);
  const update = usePwaStore((s) => s.update);
  if (!needRefresh) return null;
  return (
    <div className="nz-update" role="status" aria-live="polite" data-testid="update-banner">
      <span className="nz-update-ic" aria-hidden>
        {updating ? <Loader size={16} color="currentColor" /> : <IconRefresh size={18} stroke={1.9} />}
      </span>
      <span className="nz-update-text">
        <b>{t('pwa.updateTitle')}</b>
        <span>{waitingForSync ? t('pwa.waitingForSync') : updating ? t('pwa.updating') : t('pwa.updateBody')}</span>
      </span>
      <button type="button" className="nz-update-btn" onClick={() => void update?.()} disabled={updating || !update}>
        {t('pwa.updateNow')}
      </button>
    </div>
  );
}
