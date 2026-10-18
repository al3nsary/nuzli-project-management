import { useEffect, type ReactNode } from 'react';
import { IconCloudOff, IconTimelineEvent, IconUsersGroup } from '@tabler/icons-react';
import { IS_DEMO } from '../../api';
import { documentTitle } from '../../app/nav';
import { t } from '../../i18n';
import { MuhsenSystemLine, NozolyLogo } from '../../components/Brand';

const VALUES = [
  { icon: IconTimelineEvent, title: 'auth.value1', sub: 'auth.value1Sub' },
  { icon: IconUsersGroup, title: 'auth.value2', sub: 'auth.value2Sub' },
  { icon: IconCloudOff, title: 'auth.value3', sub: 'auth.value3Sub' },
] as const;

/**
 * Public pages (login, register, pending, forgot/reset/change password) — owner request A9.
 * A clean white page: the form card with the Nozoly logo large at its top (220px desktop,
 * 164px on phones), the page title and a sub-line; on desktop an indigo-tinted panel on the
 * inline end with three short value lines; «منظومة مُحسن» with the small Muhsen mark in the
 * footer. Phones (360px): one column, the card flat on white.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  width = 440,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    document.title = documentTitle(title, t('app.name'));
  }, [title]);

  return (
    <div className="nz-auth">
      {IS_DEMO ? (
        <div className="demo-strip" role="note">
          {t('shell.demoStrip')}
        </div>
      ) : null}
      <div className="nz-auth-grid">
        <main className="nz-auth-main" id="main">
          <div className="nz-auth-card" style={{ maxWidth: width }}>
            <header className="nz-auth-logo">
              <NozolyLogo width={220} className="nz-auth-logo-wide" />
              <NozolyLogo width={164} className="nz-auth-logo-narrow" />
            </header>
            <div className="nz-auth-head">
              <h1 tabIndex={-1}>{title}</h1>
              {subtitle ? <p className="nz-auth-sub">{subtitle}</p> : null}
            </div>
            <div className="nz-auth-body">{children}</div>
          </div>
          <footer className="nz-auth-foot">
            <MuhsenSystemLine />
          </footer>
        </main>

        <aside className="nz-auth-side" aria-label={t('auth.valueTitle')}>
          <div className="nz-auth-side-in">
            <p className="nz-auth-kicker">{t('app.name')}</p>
            <h2>{t('auth.valueTitle')}</h2>
            <ul className="nz-auth-values">
              {VALUES.map((v) => (
                <li key={v.title}>
                  <span className="nz-auth-vic" aria-hidden>
                    <v.icon size={21} stroke={1.7} />
                  </span>
                  <div>
                    <b>{t(v.title)}</b>
                    <span>{t(v.sub)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
