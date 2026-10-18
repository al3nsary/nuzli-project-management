import { Link } from 'react-router-dom';
import { Button } from '@mantine/core';
import { IconHome } from '@tabler/icons-react';
import { navLeaves } from '../app/nav';
import { PageHeader } from '../components/ui';
import { t, type MessageKey } from '../i18n';

/**
 * A page announced by owner request A9 whose screen is being built in this release (portfolios,
 * time log, reports, workload, communication hub, attachments, organisation structure). It has
 * a registry entry, a route and a permission guard like any page, so the navigation is final.
 */
export function ComingSoonPage({ id }: { id: string }) {
  const node = navLeaves().find((n) => n.id === id);
  if (!node) return null;
  const Icon = node.icon;
  const title = t(node.title ?? node.label);
  return (
    <>
      <PageHeader title={title} />
      <section className="nz-soon" aria-labelledby={`nz-soon-${id}`}>
        <span className="nz-soon-ic" aria-hidden>
          <Icon size={28} stroke={1.6} />
        </span>
        <span className="pill brand">{t('soon.badge')}</span>
        <h2 id={`nz-soon-${id}`} className="nz-soon-title">
          {t('soon.title')}
        </h2>
        <p className="nz-soon-body">{t(`soon.body.${id}` as MessageKey)}</p>
        <Button component={Link} to="/" variant="default" leftSection={<IconHome size={17} />}>
          {t('error.goHome')}
        </Button>
      </section>
    </>
  );
}
