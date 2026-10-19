import { IconColorSwatch } from '@tabler/icons-react';
import { t } from '../i18n';
import { useDesignStore } from '../theme/design';

/**
 * Owner request A11: switches between the current design and the new (Figma) one so the two can be
 * compared side by side. Shown in the top bar and on the public pages until the owner decides.
 */
export function DesignToggle({ className }: { className?: string }) {
  const figma = useDesignStore((s) => s.design === 'figma');
  const toggle = useDesignStore((s) => s.toggle);
  return (
    <button
      type="button"
      className={['nz-chip', 'nz-design-toggle', className].filter(Boolean).join(' ')}
      onClick={toggle}
      aria-pressed={figma}
      aria-label={figma ? t('design.backToClassicAria') : t('design.tryNewAria')}
    >
      <IconColorSwatch size={16} stroke={1.7} aria-hidden />
      <span className="nz-design-toggle-label">{figma ? t('design.backToClassic') : t('design.tryNew')}</span>
    </button>
  );
}
