import type { CardModel } from '../config';
import { CardShell, FieldRow, hasQr, LogoRow, NameBlock, Photo, QrCode, sortForDisplay } from '../parts';
import { BODY_LINE_HEIGHT, computeFrame, NAME_LINE_HEIGHT, planText, rowSpecs, type RowKind } from '../plan';
import { lineBoxMm } from '../fit';
import { clamp, mm } from '../units';

const BADGE_ORDER: RowKind[] = ['jobTitle', 'team', 'nationalId', 'department', 'validUntil'];

/** Vertical badge: centred logo, photo, name, team and fields, QR at the foot. Best in portrait. */
export function VerticalBadge({ model }: { model: CardModel }) {
  const frame = computeFrame(model);
  const { innerW, innerH, gap } = frame;
  const { config } = model;

  // Reserve room for at least one name line and the team row; on short (landscape) media the
  // photo goes first, then the QR shrinks, so the name and team always stay readable.
  const textMin =
    lineBoxMm(Math.max(5, config.fontSizes.name * 0.6), NAME_LINE_HEIGHT) +
    (model.team ? lineBoxMm(Math.max(4, config.fontSizes.body * 0.75), BODY_LINE_HEIGHT) : 0);
  let room = innerH - textMin;
  const logoH = model.logoUrl && room >= 3 + gap ? clamp(innerH * 0.11, 3, 14) : 0;
  room -= logoH ? logoH + gap : 0;
  let qr = hasQr(model) ? Math.min(innerW * 0.42, innerH * 0.26, 30) : 0;
  let photoW = model.photoUrl ? Math.min(innerW * 0.45, (innerH * 0.26) / 1.25) : 0;
  if (photoW && photoW * 1.25 + gap + (qr ? qr + gap : 0) > room) photoW = 0;
  const photoH = photoW * 1.25;
  room -= photoW ? photoH + gap : 0;
  if (qr && qr + gap > room) qr = room - gap >= 6 ? room - gap : 0;
  const fixed = (logoH ? logoH + gap : 0) + (photoW ? photoH + gap : 0) + (qr ? qr + gap : 0);

  const plan = planText({
    name: model.fullName,
    rows: rowSpecs(model, config.fontSizes.body * 0.3528),
    widthMm: innerW,
    heightMm: Math.max(0, innerH - fixed),
    namePt: config.fontSizes.name,
    bodyPt: config.fontSizes.body,
    maxNameLines: 2,
    gapMm: gap * 0.4,
  });

  return (
    <CardShell model={model} frame={frame} layout="vertical-badge">
      <LogoRow model={model} heightMm={logoH} widthMm={innerW} />
      {photoW ? (
        <div className="nz-center">
          <Photo url={model.photoUrl!} widthMm={photoW} heightMm={photoH} />
        </div>
      ) : null}
      <div className="nz-text nz-center-text" style={{ gap: mm(gap * 0.4) }} data-dropped={plan.dropped.join(',') || undefined}>
        <NameBlock name={model.fullName} sizePt={plan.namePt} lines={plan.nameLines} align="center" />
        <div className="nz-rows">
          {sortForDisplay(plan.rows, BADGE_ORDER).map((row) => (
            <FieldRow key={row.kind} row={row} sizePt={plan.bodyPt} model={model} align="center" />
          ))}
        </div>
      </div>
      {qr ? (
        <div className="nz-center nz-push-end">
          <QrCode model={model} sizeMm={qr} />
        </div>
      ) : null}
    </CardShell>
  );
}
