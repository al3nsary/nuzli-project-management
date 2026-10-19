import type { CardModel } from '../config';
import { CardShell, FieldRow, hasQr, LogoRow, NameBlock, PHOTO_ASPECT, PhotoArea, QrCode, sortForDisplay } from '../parts';
import { BODY_LINE_HEIGHT, computeFrame, NAME_LINE_HEIGHT, planText, rowSpecs, type RowKind } from '../plan';
import { lineBoxMm } from '../fit';
import { clamp, mm } from '../units';

const BADGE_ORDER: RowKind[] = ['role', 'jobTitle', 'team', 'nationalId', 'department', 'validUntil'];

/** Photo height at CR80 portrait: about 26×34 mm when the text leaves room; scales with the short side. */
export const BADGE_PHOTO_H_MM = 34;
/** The photo shrinks to this height before it is left out; the QR first shrinks to BADGE_QR_MIN_MM. */
export const BADGE_PHOTO_MIN_H_MM = 16;
export const BADGE_QR_MIN_MM = 13;

/**
 * Vertical badge: centred logo, photo (top-centre, 3:4), name, team and fields, QR at the foot.
 * Best in portrait. Space is shared in this order: the text at its template size, then the photo
 * and the QR — the QR shrinks to 13 mm first, then the photo to 16 mm; on media too short for
 * both (landscape) the photo is left out before the QR. planText then fits whatever remains.
 */
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
  const rows = rowSpecs(model, config.fontSizes.body * 0.3528);
  // Room left for photo + QR once the core text (one name line, team, job title, national ID)
  // has its template size. Department and validity date may be dropped for the photo.
  const core = rows.filter((r) => r.priority <= 3).length;
  room =
    innerH -
    (logoH ? logoH + gap : 0) -
    lineBoxMm(config.fontSizes.name, NAME_LINE_HEIGHT) -
    core * lineBoxMm(config.fontSizes.body, BODY_LINE_HEIGHT) -
    (core ? gap * 0.4 : 0);
  const scale = Math.min(model.dims.widthMm, model.dims.heightMm) / 54;
  let qr = hasQr(model) ? Math.min(innerW * 0.42, innerH * 0.26, 30) : 0;
  let photoH = model.showPhoto ? Math.min(BADGE_PHOTO_H_MM * scale, innerW * 0.55 * PHOTO_ASPECT, innerH * 0.45) : 0;
  const photoPart = () => (photoH ? photoH + gap : 0);
  const qrPart = () => (qr ? qr + gap : 0);
  if (qr && photoH && photoPart() + qrPart() > room) qr = Math.min(qr, Math.max(BADGE_QR_MIN_MM, room - photoPart() - gap));
  if (photoH && photoPart() + qrPart() > room) photoH = Math.max(BADGE_PHOTO_MIN_H_MM, room - qrPart() - gap);
  if (photoH && photoPart() + qrPart() > room) photoH = 0;
  // Like before A8: the QR keeps at least 6 mm against the minimum text, else it is left out.
  const qrRoom = innerH - textMin - (logoH ? logoH + gap : 0) - photoPart();
  if (qr && qr + gap > qrRoom) qr = qrRoom - gap >= 6 ? qrRoom - gap : 0;
  const photoW = photoH / PHOTO_ASPECT;
  const fixed = (logoH ? logoH + gap : 0) + (photoW ? photoH + gap : 0) + (qr ? qr + gap : 0);

  const plan = planText({
    name: model.fullName,
    rows,
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
      {photoH ? (
        <div className="nz-center">
          <PhotoArea model={model} widthMm={photoW} heightMm={photoH} />
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
