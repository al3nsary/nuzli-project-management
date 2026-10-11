import type { CardModel } from '../config';
import { CardShell, FieldRow, hasQr, LogoRow, NameBlock, Photo, QrCode, sortForDisplay } from '../parts';
import { computeFrame, planText, rowSpecs } from '../plan';
import { clamp, mm } from '../units';

/**
 * Classic horizontal ID card: logo header, then photo (start) · name and fields · QR (end).
 * In RTL the start side is on the right.
 */
export function ClassicHorizontal({ model }: { model: CardModel }) {
  const frame = computeFrame(model);
  const { innerW, innerH, gap } = frame;
  const { config } = model;

  const logoH = model.logoUrl ? clamp(innerH * 0.2, 3.5, 12) : 0;
  const bodyH = Math.max(0, innerH - (logoH ? logoH + gap : 0));
  const qr = hasQr(model) ? Math.min(bodyH, clamp(innerW * 0.28, 6, 30)) : 0;
  const photoW = model.photoUrl ? Math.min(innerW * 0.22, bodyH / 1.25) : 0;
  const photoH = photoW * 1.25;
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
        {photoW ? <Photo url={model.photoUrl!} widthMm={photoW} heightMm={photoH} /> : null}
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
