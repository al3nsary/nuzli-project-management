import type { CardModel } from '../config';
import { CardShell, FieldRow, hasQr, LogoRow, NameBlock, PHOTO_ASPECT, PhotoArea, QrCode, sortForDisplay } from '../parts';
import { computeFrame, planText, rowSpecs } from '../plan';
import { clamp, mm } from '../units';

/** Photo width at CR80 (85.6×54): about 22×29 mm; other sizes scale with the short side. */
export const CLASSIC_PHOTO_W_MM = 22;
/** Below this width the photo area is left out (the text needs the room). */
export const CLASSIC_PHOTO_MIN_W_MM = 8;

/**
 * Classic horizontal ID card: logo header, then photo (start) · name and fields · QR (end).
 * In RTL the start side is on the right. The photo area (3:4) is reserved whenever
 * `fields.photo` is on — the initials placeholder stands in for a missing photo — and the text
 * column is planned in the width that remains.
 */
export function ClassicHorizontal({ model }: { model: CardModel }) {
  const frame = computeFrame(model);
  const { innerW, innerH, gap } = frame;
  const { config } = model;

  const logoH = model.logoUrl ? clamp(innerH * 0.2, 3.5, 12) : 0;
  const bodyH = Math.max(0, innerH - (logoH ? logoH + gap : 0));
  const scale = Math.min(model.dims.widthMm, model.dims.heightMm) / 54;
  const qr = hasQr(model) ? Math.min(bodyH, clamp(innerW * (model.showPhoto ? 0.22 : 0.28), 6, 30)) : 0;
  let photoW = model.showPhoto ? Math.min(CLASSIC_PHOTO_W_MM * scale, innerW * 0.3, bodyH / PHOTO_ASPECT) : 0;
  if (photoW < CLASSIC_PHOTO_MIN_W_MM) photoW = 0;
  const photoH = photoW * PHOTO_ASPECT;
  const textW = Math.max(0, innerW - qr - photoW - (qr ? gap : 0) - (photoW ? gap : 0));

  const plan = planText({
    name: model.fullName,
    rows: rowSpecs(model, config.fontSizes.body * 0.3528),
    widthMm: textW,
    heightMm: bodyH,
    namePt: config.fontSizes.name,
    bodyPt: config.fontSizes.body,
    maxNameLines: 2,
    gapMm: gap * 0.4,
  });

  return (
    <CardShell model={model} frame={frame} layout="classic-horizontal">
      <LogoRow model={model} heightMm={logoH} widthMm={innerW} />
      <div className="nz-hstack nz-grow" style={{ gap: mm(gap) }}>
        {photoW ? <PhotoArea model={model} widthMm={photoW} heightMm={photoH} /> : null}
        <div className="nz-text nz-grow" style={{ gap: mm(gap * 0.4) }} data-dropped={plan.dropped.join(',') || undefined}>
          <NameBlock name={model.fullName} sizePt={plan.namePt} lines={plan.nameLines} />
          <div className="nz-rows">
            {sortForDisplay(plan.rows).map((row) => (
              <FieldRow key={row.kind} row={row} sizePt={plan.bodyPt} model={model} />
            ))}
          </div>
        </div>
        {qr ? (
          <div className="nz-qr-box" style={{ alignSelf: 'flex-end' }}>
            <QrCode model={model} sizeMm={qr} />
          </div>
        ) : null}
      </div>
    </CardShell>
  );
}
