import { useEffect, type ReactNode } from 'react';
import { Title, Text } from '@mantine/core';
import { IS_DEMO } from '../../api';
import { documentTitle } from '../../app/nav';
import { t } from '../../i18n';
import { brandUrl, NozolyCredit } from '../../components/Brand';

/**
 * Public pages (login, register, pending, forgot/reset/change password) — owner request A7.
 * Desktop: a split screen. The Muhsen green panel on the inline start carries the Muhsen lockup
 * (white, 168px), the pattern at ≤ .06 and one value line; the form panel carries «نُزلي» and
 * «تطوير نُزلي» with the Nozoly logo (green by day, light by night). Phones: stacked, like the
 * Muhsen app login (green header, white sheet).
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
        <aside className="nz-auth-hero" aria-label={t('brand.system')}>
          <img className="nz-auth-pattern" src={brandUrl('muhsen-pattern.png')} alt="" aria-hidden draggable={false} />
          <div className="nz-auth-hero-in">
            <img
              className="nz-auth-lockup"
              src={brandUrl('muhsen-lockup-white.png')}
              alt={t('brand.muhsenLogo')}
              width={168}
              draggable={false}
            />
            <div className="nz-auth-value">
              <p className="nz-auth-line">{t('brand.valueLine')}</p>
              <p className="nz-auth-cap">{t('brand.valueCaption')}</p>
            </div>
            <p className="nz-auth-system">
              <span className="nz-auth-dot" aria-hidden />
              {t('brand.system')}
            </p>
          </div>
        </aside>

        <main className="nz-auth-main" id="main">
          <div className="nz-auth-sheet" style={{ maxWidth: width }}>
            <header className="nz-auth-brand">
              <span className="nz-auth-name">{t('app.name')}</span>
              <span className="nz-auth-tag">{t('app.tagline')}</span>
            </header>
            <div className="nz-auth-head">
              <Title order={1} tabIndex={-1}>
                {title}
              </Title>
              {subtitle ? (
                <Text c="dimmed" mt={4} size="sm">
                  {subtitle}
                </Text>
              ) : null}
            </div>
            <div className="nz-auth-body">{children}</div>
            <footer className="nz-auth-foot">
              <NozolyCredit variant="green" className="nz-credit--day" />
              <NozolyCredit variant="light" className="nz-credit--night" />
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
