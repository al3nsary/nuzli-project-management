import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { WorkloadDto } from '@nuzli/shared';
import { UserAvatar } from '../../components/UserAvatar';
import { formatDate, formatMinutes, formatNumber, getDisplayPrefs, t } from '../../i18n';
import { DEFAULT_WEEKEND, dayTotals, hoursOf, isWeekend, loadLevel, personTotals, type LoadLevel } from './math';
import './workload.css';

const weekdayFmt = () => new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${getDisplayPrefs().digits}`, { weekday: 'short', timeZone: 'UTC' });
const monthFmt = () => new Intl.DateTimeFormat(`ar-SA-u-ca-gregory-nu-${getDisplayPrefs().digits}`, { month: 'long', timeZone: 'UTC' });
const utc = (d: string) => new Date(`${d}T00:00:00Z`);
const hours = (min: number) => formatNumber(hoursOf(min));

export const LEVELS: LoadLevel[] = ['idle', 'light', 'balanced', 'full', 'over'];

/**
 * The workload heat grid (A9 «عبء العمل»), shared by the workload page and the project tab:
 * one row per person, one column per day. Cells are shaded by allocated hours ÷ capacity;
 * an overload (above the capacity) is red with its hours; weekends are hatched; logged hours are
 * the small second figure and in the cell's tooltip. The person column is sticky and only the
 * grid scrolls sideways. Days flow in reading order (right → left in Arabic) because the table
 * follows the page direction.
 */
export function WorkloadGrid({
  data,
  weekendDays = DEFAULT_WEEKEND,
  today,
  label,
}: {
  data: WorkloadDto;
  weekendDays?: readonly number[];
  today: string;
  label: string;
}) {
  const cap = data.capacityMinutesPerDay;
  const scroller = useRef<HTMLDivElement>(null);
  const totals = useMemo(() => dayTotals(data.people), [data.people]);
  const people = useMemo(
    () => data.people.map((p) => ({ person: p, totals: personTotals(p, cap, weekendDays), byDate: new Map(p.days.map((d) => [d.date, d])) })),
    [data.people, cap, weekendDays],
  );
  const wd = weekdayFmt();
  const mf = monthFmt();

  // Bring today into view once per range (logical: scrollIntoView honours the direction).
  useEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>('[data-today]');
    if (el && typeof el.scrollIntoView === 'function') {
      const top = window.scrollY;
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
      if (window.scrollY !== top) window.scrollTo({ top });
    }
  }, [data.from, data.to]);

  return (
    <div className="wl-wrap">
      <div className="wl-scroll" ref={scroller} role="region" aria-label={label} tabIndex={0}>
        <table className="wl-table" style={{ '--wl-cols': data.days.length } as CSSProperties}>
          <thead>
            <tr>
              <th className="wl-corner" scope="col">
                {t('a9r.wl.person')}
              </th>
              {data.days.map((d, i) => {
                const first = i === 0 || d.endsWith('-01');
                return (
                  <th
                    key={d}
                    scope="col"
                    className="wl-day-h"
                    data-weekend={isWeekend(d, weekendDays) || undefined}
                    data-today={d === today || undefined}
                    data-month-start={first || undefined}
                    title={formatDate(d)}
                  >
                    <span className="wl-month">{first ? mf.format(utc(d)) : ' '}</span>
                    <span className="wl-wd">{wd.format(utc(d))}</span>
                    <span className="wl-dn num">{formatNumber(Number(d.slice(8, 10)))}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {people.map(({ person, totals: pt, byDate }) => (
              <tr key={person.user.id}>
                <th scope="row" className="wl-person">
                  <span className="wl-person-in">
                    <UserAvatar name={person.user.fullName} size={30} ring={false} />
                    <span className="wl-person-txt">
                      <span className="wl-person-name">{person.user.fullName}</span>
                      <span className="wl-person-meta">
                        <span className="num" title={t('a9r.wl.totalTitle')}>
                          {t('a9r.wl.hoursOf', { h: hours(pt.assignedMinutes), cap: hours(pt.capacityMinutes) })}
                        </span>
                        {pt.overloadDays ? <span className="wl-over-chip">{t('a9r.wl.overDays', { n: pt.overloadDays })}</span> : null}
                      </span>
                    </span>
                  </span>
                </th>
                {data.days.map((d) => {
                  const day = byDate.get(d);
                  const assigned = day?.assignedMinutes ?? 0;
                  const logged = day?.loggedMinutes ?? 0;
                  const level = loadLevel(assigned, cap);
                  const weekend = isWeekend(d, weekendDays);
                  const tip = [
                    `${person.user.fullName} · ${formatDate(d)}`,
                    assigned ? t('a9r.wl.tipAssigned', { h: hours(assigned), cap: hours(cap) }) : t('a9r.wl.tipFree'),
                    day?.taskCount ? t('a9r.wl.tipTasks', { n: day.taskCount }) : null,
                    logged ? t('a9r.wl.tipLogged', { time: formatMinutes(logged) }) : null,
                    level === 'over' ? t('a9r.wl.tipOver', { h: hours(assigned - cap) }) : null,
                    weekend ? t('a9r.wl.weekend') : null,
                  ]
                    .filter(Boolean)
                    .join('\n');
                  return (
                    <td key={d} className="wl-cell" data-level={level} data-weekend={weekend || undefined} data-today={d === today || undefined} title={tip}>
                      {assigned ? <span className="wl-h num">{hours(assigned)}</span> : null}
                      {logged ? <span className="wl-l num">{hours(logged)}</span> : null}
                      <span className="sr-only">{tip}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="wl-person wl-foot-h">
                {t('a9r.wl.dayTotal')}
              </th>
              {data.days.map((d) => {
                const s = totals.get(d);
                return (
                  <td key={d} className="wl-foot" data-weekend={isWeekend(d, weekendDays) || undefined}>
                    {s?.assignedMinutes ? <span className="num">{hours(s.assignedMinutes)}</span> : <span className="wl-zero">·</span>}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <WorkloadLegend capHours={hoursOf(cap)} />
    </div>
  );
}

export function WorkloadLegend({ capHours }: { capHours: number }) {
  return (
    <ul className="wl-legend" aria-label={t('a9r.wl.legend')}>
      {(['light', 'balanced', 'full', 'over'] as const).map((l) => (
        <li key={l}>
          <span className="wl-sw" data-level={l} aria-hidden />
          {t(`a9r.wl.level.${l}`)}
        </li>
      ))}
      <li>
        <span className="wl-sw wl-sw--weekend" aria-hidden />
        {t('a9r.wl.weekend')}
      </li>
      <li className="wl-legend-note">{t('a9r.wl.legendNote', { h: formatNumber(capHours) })}</li>
    </ul>
  );
}
