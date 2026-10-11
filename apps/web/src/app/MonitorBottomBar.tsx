import { NavLink } from 'react-router-dom';
import { Badge } from '@mantine/core';
import { IconCamera, IconClipboardList, IconCloudUpload } from '@tabler/icons-react';
import { useAuthStore } from '../stores/auth';
import { useUnsyncedCount } from '../features/violations/offline/runtime';
import { formatNumber, t } from '../i18n';

/**
 * The monitor's bottom bar on phones (design skill): تسجيل مخالفة · مخالفاتي ·
 * بانتظار المزامنة with a count badge. Hidden from 768px up (the sidebar takes over) and in print.
 */
export function MonitorBottomBar() {
  const user = useAuthStore((s) => s.user);
  const pending = useUnsyncedCount(user?.id);
  return (
    <nav className="nz-bottombar" aria-label={t('nav.bottomBar')}>
      <NavLink to="/violations/new" className="nz-bottombar-item">
        <IconCamera size={24} stroke={1.7} aria-hidden />
        <span>{t('nav.recordViolation')}</span>
      </NavLink>
      <NavLink to="/violations/mine" className="nz-bottombar-item">
        <IconClipboardList size={24} stroke={1.7} aria-hidden />
        <span>{t('nav.myViolations')}</span>
      </NavLink>
      <NavLink to="/violations/pending" className="nz-bottombar-item">
        <span className="nz-bottombar-icon">
          <IconCloudUpload size={24} stroke={1.7} aria-hidden />
          {pending ? (
            <Badge
              className="nz-bottombar-badge"
              color="signal"
              variant="filled"
              size="sm"
              circle={pending < 10}
              aria-label={t('outbox.badgeAria', { n: pending })}
            >
              {formatNumber(pending)}
            </Badge>
          ) : null}
        </span>
        <span>{t('nav.pendingSync')}</span>
      </NavLink>
    </nav>
  );
}
