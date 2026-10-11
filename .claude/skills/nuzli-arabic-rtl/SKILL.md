---
name: nuzli-arabic-rtl
description: Arabic-first and RTL rules for Nuzli — i18n files, logical CSS, physical-offset sign rule, Gantt direction, digits, Hijri dates, Saudi validators (national ID, mobile), Excel RTL. Load before writing any UI text, layout, date/number formatting or export.
---

# العربية واتجاه RTL في نزلي

## النصوص
- Every user-visible string lives in `apps/web/src/i18n/ar.ts` and is read with `t('key')`. `en.ts` is a scaffold with the same keys (brief §12).
- A build check (`pnpm --filter web check:i18n`) fails if a key is missing in `ar`, or if a `.tsx` file contains a Latin-letter JSX text literal.
- Copy: plain Modern Standard Arabic, sentence-like, active verbs. «اعتماد» not «موافقة على الطلب».

## الاتجاه
- `<html dir="rtl" lang="ar">`. Mantine `DirectionProvider initialDirection="rtl"`.
- **Logical CSS only:** `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-start-start-radius`, `text-align: start`.
- **Physical offsets don't flip.** `transform: translateX`, `scrollLeft`, SVG `x`, canvas coordinates and pointer `clientX` deltas are physical. Multiply by `dirSign()` (`-1` in RTL), or compute in "logical x" and convert once at render. Test in both directions.
- Icons that imply direction (back/next arrows, chevrons, "send", undo/redo) are mirrored with `.mirror-rtl { transform: scaleX(-1) }` in RTL. Clocks, checkmarks and media "play" are **not** mirrored.

## Gantt
- Time flows **right to left**: today's x is computed as `width - (day - start) * dayWidth`. The task grid is on the right and the timeline on the left.
- Dragging a bar to the **left** moves it **later** in RTL.

## الأرقام والتواريخ
- Western digits by default (`ar-SA-u-nu-latn`), with a user setting for Arabic-Indic (`ar-SA-u-nu-arab`).
- Gregorian by default (`ar-SA-u-ca-gregory`). Optional Hijri row: `Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura')`.
- Storage is UTC; display uses `Asia/Riyadh`.
- Week starts on **Sunday**. The weekend is **Friday and Saturday**.

## مدقّقات سعودية (`packages/shared/src/validators/`)
- Mobile: accept `05XXXXXXXX`, `5XXXXXXXX`, `9665XXXXXXXX`, `+9665XXXXXXXX` → normalise to E.164 `+9665XXXXXXXX`.
- National ID / Iqama: 10 digits, the first is `1` (citizen) or `2` (resident). Check digit (Luhn variant): for each of the first 9 digits, positions 1, 3, 5, 7 and 9 (odd, 1-based) are doubled and their digits summed; even positions are added as is; check = (10 − sum mod 10) mod 10.
- Mask: `1•••••••23` (first digit, 7 bullets, last two).

## Excel (brief §7.7 — strict)
- `views: [{ rightToLeft: true }]` on **every** sheet. **Never** `state: 'frozen'` (no freeze panes).
- Real date cells (`numFmt: 'yyyy-mm-dd hh:mm'`), Arabic headers, auto-fitted widths.
