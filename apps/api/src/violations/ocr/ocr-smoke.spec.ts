import { TesseractEngine } from './ocr-engine';
import { parseIdCard } from './ocr-parser';
import { renderTextPng } from '../../../test/unit/ocr-test-image';

/**
 * Smoke test with the REAL engine (tesseract.js WASM + the self-hosted ara+eng LSTM data from
 * @tesseract.js-data — no network). The image is drawn with a 5×7 bitmap font (no canvas), so it
 * carries digits and separators only; Arabic lines cannot be rendered without a font and are
 * covered by the parser tests on synthetic OCR text. Set OCR_SMOKE=0 to skip on slow machines.
 */
const run = process.env.OCR_SMOKE === '0' ? describe.skip : describe;

run('OCR smoke — real tesseract.js on a generated card image (A9, ADR-104)', () => {
  const engine = new TesseractEngine();
  afterAll(() => engine.terminate());

  it('reads a valid Iqama number and a date from the PNG, and the parser extracts them', async () => {
    const png = renderTextPng(['2345678904', '1447/03/15']);
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    const result = await engine.recognize(png);
    const card = parseIdCard({ text: result.text, lines: result.lines });
    expect(card.nationalId?.value).toBe('2345678904');
    expect(card.nationalId!.confidence).toBeGreaterThan(30);
    expect(card.expiryDate ?? card.birthDate).toMatchObject({ value: '1447-03-15', calendar: 'HIJRI' });
  }, 120_000);

  it('a number with a wrong check digit is read but not accepted', async () => {
    const result = await engine.recognize(renderTextPng(['1023456780']));
    expect(result.text.replace(/\D/g, '')).toContain('1023456780');
    expect(parseIdCard({ text: result.text, lines: result.lines }).nationalId).toBeNull();
  }, 120_000);
});
