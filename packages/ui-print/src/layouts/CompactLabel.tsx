import type { CardModel } from '../config';
import { CardShell, FieldRow, hasQr, LogoRow, NameBlock, Photo, QrCode, sortForDisplay } from '../parts';
import { computeFrame, planText, rowSpecs, type RowSpec } from '../plan';
import { clamp, mm } from '../units';

/**
 * Compact label for small media (57×32, 90×40): no field labels except the validity date,
 * job title and department merged on one line, QR filling the end side.
 */
export function CompactLabel({ model }: { model: CardModel }) {
  const frame = computeFrame(model);
  const { innerW, innerH, gap } = frame;
  const { config } = model;

  const qr = hasQr(model) ? Math.min(innerH, clamp(innerW * 0.34, 6, 26)) : 0;
  const photoW = model.photoUrl ? Math.min(innerW * 0.2, innerH / 1.25) : 0;
  const textW = Math.max(0, innerW - qr - photoW - (qr ? gap : 0) - (photoW ? gap : 0));
  const logoH = model.logoUrl ? clamp(innerH * 0.16, 3, 8) : 0;

  const rows = mergeJobAndDepartment(rowSpecs(model, config.fontSizes.body * 0.3528, { labels: false }));
  const plan = planText({
    name: model.fullName,
    rows,
    widthMm: textW,
    heightMm: Math.max(0, innerH - (logoH ? logoH + gap * 0.5 : 0)),
    namePt: config.fontSizes.name,
    bodyPt: config.fontSizes.body,
    maxNameLines: innerH >= 24 ? 2 : 1,
    gapMm: gap * 0.25,
  });

  return (
    <CardShell model={model} frame={frame} layout="compact-label">
      <div className="nz-hstack nz-grow" style={{ gap: mm(gap) }}>
        {photoW ? <Photo url={model.photoUrl!} widthMm={photoW} heightMm={photoW * 1.25} /> : null}
        <div className="nz-text nz-grow" style={{ gap: mm(gap * 0.25) }} data-dropped={plan.dropped.join(',') || undefined}>
          <LogoRow model={model} heightMm={logoH} widthMm={textW} />
          <NameBlock name={model.fullName} sizePt={plan.namePt} lines={plan.nameLines} />
          <div className="nz-rows">
            {sortForDisplay(plan.rows).map((row) => (
              <FieldRow key={row.kind} row={row} sizePt={plan.bodyPt} model={model} />
            ))}
          </div>
        </div>
        {qr ? (
          <div className="nz-qr-box" style={{ alignSelf: 'center' }}>
            <QrCode model={model} sizeMm={qr} />
          </div>
        ) : null}
      </div>
    </CardShell>
  );
}

/** «المسمى · القسم» on one line to save height on small labels. */
function mergeJobAndDepartment(rows: RowSpec[]): RowSpec[] {
  const job = rows.find((r) => r.kind === 'jobTitle');
  const dept = rows.find((r) => r.kind === 'department');
  if (!job || !dept) return rows;
  return rows
    .filter((r) => r !== dept)
    .map((r) => (r === job ? { ...job, value: `${job.value} · ${dept.value}` } : r));
}
