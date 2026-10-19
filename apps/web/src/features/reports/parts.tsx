import type { ReactNode } from 'react';
import { Progress, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import { formatMoney, t, tCount, type MessageKey } from '../../i18n';
import { formatPct, meterValue, remainingOf, toneColor, usedPct, usedTone } from './budget';
import './reports.css';

/**
 * «متأخرة يومًا واحدًا / يومين / ٥ أيام / ١٢ يومًا / ١٠٣ أيام / ١٠٠ يوم» — CALENDAR days from the due
 * day (shared `calendarDaysOverdue`). The Gantt bar label and the dashboard use this one wording (L1).
 */
export const overdueText = (days: number) => tCount('a9r.overdue', days);

/** «يوم واحد / يومان / ٥ أيام / ١٢ يومًا / ١٠٠ يوم». */
export const daysText = (days: number) => tCount('a9r.days', days);

export function Kpi({
  label,
  value,
  foot,
  icon: IconCmp,
  tone,
  small,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  icon?: Icon;
  tone?: 'no' | 'wait';
  small?: boolean;
}) {
  return (
    <div className="rp-kpi" data-tone={tone}>
      <div className="rp-kpi-label">
        {IconCmp ? <IconCmp size={15} stroke={1.8} aria-hidden /> : null}
        <span>{label}</span>
      </div>
      <div className={small ? 'rp-kpi-value rp-kpi-value--sm num' : 'rp-kpi-value num'}>{value}</div>
      {foot ? <div className="rp-kpi-foot">{foot}</div> : null}
    </div>
  );
}

export function ReportCard({
  title,
  sub,
  actions,
  children,
  flush,
  labelledBy,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  labelledBy?: string;
}) {
  const id = labelledBy ?? `rp-${title.replace(/\s+/g, '-')}`;
  return (
    <section className={flush ? 'rp-card rp-card--flush' : 'rp-card'} aria-labelledby={id}>
      <header className="rp-card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="rp-card-title" id={id}>
            {title}
          </h3>
          {sub ? <p className="rp-card-sub">{sub}</p> : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** A quiet in-card empty line (the page-level empty states use `EmptyState`). */
export function CardEmpty({ children }: { children: ReactNode }) {
  return (
    <Text size="sm" c="dimmed" py="lg" ta="center">
      {children}
    </Text>
  );
}

/** The «% used» meter: indigo, amber above 90 %, red above 100 %. */
export function BudgetMeter({ pct, size = 'md', label }: { pct: number | null | undefined; size?: 'sm' | 'md' | 'lg'; label?: string }) {
  const tone = usedTone(pct);
  if (tone === 'none') return null;
  return (
    <Progress
      value={meterValue(pct)}
      color={toneColor(tone)}
      size={size}
      radius="xl"
      aria-label={label ?? t('a9r.budget.used')}
      data-tone={tone}
      styles={{ root: { background: 'var(--panel2)' } }}
    />
  );
}

/** Budget / planned / actual / remaining / % used, with the meter underneath. */
export function BudgetTotals({
  budget,
  planned,
  actual,
  currency,
  pct,
}: {
  budget: number | null;
  planned: number;
  actual: number;
  currency: string;
  pct?: number | null;
}) {
  const used = pct === undefined ? usedPct(actual, budget) : pct;
  const tone = usedTone(used);
  const remaining = remainingOf(budget, actual);
  const money = (v: number) => formatMoney(v, currency);
  return (
    <div>
      <div className="rp-totals">
        <div className="rp-total">
          <div className="rp-total-label">{t('a9r.budget.budget')}</div>
          <div className="rp-total-value">{budget === null ? <span className="rp-dim">{t('a9r.budget.none')}</span> : money(budget)}</div>
        </div>
        <div className="rp-total">
          <div className="rp-total-label">{t('a9r.budget.planned')}</div>
          <div className="rp-total-value" data-tone={budget !== null && planned > budget ? 'warn' : undefined}>
            {money(planned)}
          </div>
        </div>
        <div className="rp-total">
          <div className="rp-total-label">{t('a9r.budget.actual')}</div>
          <div className="rp-total-value" data-tone={tone === 'over' ? 'over' : undefined}>
            {money(actual)}
          </div>
        </div>
        <div className="rp-total">
          <div className="rp-total-label">{t('a9r.budget.remaining')}</div>
          <div className="rp-total-value" data-tone={remaining !== null && remaining < 0 ? 'over' : undefined}>
            {remaining === null ? t('common.none') : money(remaining)}
          </div>
        </div>
        <div className="rp-total">
          <div className="rp-total-label">{t('a9r.budget.used')}</div>
          <div className="rp-total-value" data-tone={tone === 'over' || tone === 'warn' ? tone : undefined} data-testid="budget-used">
            {used === null ? t('common.none') : formatPct(used)}
          </div>
        </div>
      </div>
      {tone !== 'none' ? (
        <div className="rp-meter-wrap">
          <BudgetMeter pct={used} size="lg" />
          <Text size="xs" mt={6} c={tone === 'over' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'dimmed'} fw={tone === 'ok' ? 400 : 600}>
            {tone === 'over'
              ? t('a9r.budget.overBy', { amount: money(actual - (budget ?? 0)) })
              : tone === 'warn'
                ? t('a9r.budget.nearLimit')
                : t('a9r.budget.withinLimit', { pct: formatPct(used) })}
          </Text>
        </div>
      ) : null}
    </div>
  );
}
