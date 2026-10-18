import {
  cleanArabicName,
  findDates,
  fixDigitLookalikes,
  idCandidates,
  normaliseLine,
  parseIdCard,
  pickArabicName,
} from './ocr-parser';
import { nameSimilarity, normaliseName, rankByName } from './name-similarity';

// Valid check digits (computed with nationalIdCheckDigit): 1023456781, 2345678904, 1098765439.
const CITIZEN = '1023456781';
const RESIDENT = '2345678904';
const OTHER_VALID = '1098765439';
const BAD_CHECK = '1023456780';

const lines = (...t: string[]) => t.map((text) => ({ text, confidence: 90 }));

describe('OCR parser — national ID / Iqama number (A9, ADR-104)', () => {
  it('a plain 10-digit number with a valid check digit', () => {
    const card = parseIdCard({ text: `المملكة العربية السعودية\nرقم الهوية ${CITIZEN}\n` });
    expect(card.nationalId?.value).toBe(CITIZEN);
    expect(card.nationalId!.confidence).toBeGreaterThan(50);
  });

  it('Arabic-Indic and Persian digits are normalised first', () => {
    expect(parseIdCard({ text: 'رقم الهوية ١٠٢٣٤٥٦٧٨١' }).nationalId?.value).toBe(CITIZEN);
    expect(parseIdCard({ text: 'رقم الإقامة ۲۳۴۵۶۷۸۹۰۴' }).nationalId?.value).toBe(RESIDENT);
  });

  it('digits split by spaces or dashes are joined', () => {
    expect(parseIdCard({ text: 'ID No 1 0 2 3 4 5 6 7 8 1' }).nationalId?.value).toBe(CITIZEN);
    expect(parseIdCard({ text: '2345-678-904' }).nationalId?.value).toBe(RESIDENT);
    expect(parseIdCard({ text: '١٠٢٣ ٤٥٦ ٧٨١' }).nationalId?.value).toBe(CITIZEN);
  });

  it('an invalid check digit is rejected (no field rather than a wrong one)', () => {
    const card = parseIdCard({ text: `رقم الهوية ${BAD_CHECK}` });
    expect(card.nationalId).toBeNull();
    expect(idCandidates(lines(BAD_CHECK))).toEqual([]);
  });

  it('numbers that do not start with 1 or 2, or have the wrong length, are ignored', () => {
    expect(parseIdCard({ text: '3023456781 102345678 10234567811' }).nationalId).toBeNull();
  });

  it('O/l look-alikes inside a digit run are read as 0/1', () => {
    expect(fixDigitLookalikes('1O2345678l')).toBe('1023456781');
    expect(fixDigitLookalikes('Oman 10 lOl')).toBe('Oman 10 lOl'); // words are left alone
    expect(fixDigitLookalikes('2O28/O3/01')).toBe('2028/03/01');
    expect(parseIdCard({ text: 'رقم الهوية 1O2345678l' }).nationalId?.value).toBe(CITIZEN);
  });

  it('a number glued to other digits is found in a window, with a lower confidence', () => {
    const card = parseIdCard({ lines: lines(`99${CITIZEN}`), text: '' });
    expect(card.nationalId?.value).toBe(CITIZEN);
    const plain = parseIdCard({ lines: lines(CITIZEN), text: '' });
    expect(card.nationalId!.confidence).toBeLessThan(plain.nationalId!.confidence);
  });

  it('two different valid numbers: the labelled one wins and the confidence drops', () => {
    const card = parseIdCard({ lines: lines(`رقم الهوية ${OTHER_VALID}`, `${CITIZEN}`), text: '' });
    expect(card.nationalId?.value).toBe(OTHER_VALID);
    expect(card.idCandidates).toBe(2);
    const alone = parseIdCard({ lines: lines(`رقم الهوية ${OTHER_VALID}`), text: '' });
    expect(card.nationalId!.confidence).toBeLessThan(alone.nationalId!.confidence);
  });

  it('a label on the previous line counts', () => {
    const c = idCandidates(lines('رقم الهوية', CITIZEN));
    expect(c[0]).toMatchObject({ value: CITIZEN, labelled: true });
  });
});

describe('OCR parser — names', () => {
  it('the value after «الاسم:» on the same line', () => {
    const card = parseIdCard({ text: `المملكة العربية السعودية\nوزارة الداخلية\nالاسم: محمد عبدالله سالم القحطاني\nرقم الهوية ${CITIZEN}` });
    expect(card.name?.value).toBe('محمد عبدالله سالم القحطاني');
  });

  it('the line below «الاسم» when the label stands alone', () => {
    expect(pickArabicName(lines('الاسم', 'فهد سعد العتيبي', `${CITIZEN}`))?.value).toBe('فهد سعد العتيبي');
  });

  it('without a label: the longest Arabic line near the top that is not card furniture', () => {
    const card = parseIdCard({
      lines: lines('المملكة العربية السعودية', 'وزارة الداخلية', 'هوية وطنية', 'خالد بن سعيد الغامدي', `${CITIZEN}`, 'تاريخ الميلاد 1410/05/12'),
      text: '',
    });
    expect(card.name?.value).toBe('خالد بن سعيد الغامدي');
    expect(card.name!.confidence).toBeLessThan(90); // heuristic, not labelled
  });

  it('diacritics, tatweel and stray punctuation are removed; one-word lines are not names', () => {
    expect(normaliseLine('مُحَمَّـــد  أحمد')).toBe('محمد أحمد');
    expect(cleanArabicName('عمر، فاروق.')).toBe('عمر فاروق');
    expect(cleanArabicName('المملكة العربية السعودية')).toBeNull();
    expect(cleanArabicName('سعيد')).toBeNull();
  });

  it('the Latin name of an Iqama', () => {
    const card = parseIdCard({ lines: lines('KINGDOM OF SAUDI ARABIA', 'RESIDENT IDENTITY', 'MOHAMMED RAFIQ KHAN', RESIDENT), text: '' });
    expect(card.nameLatin?.value).toBe('MOHAMMED RAFIQ KHAN');
    expect(parseIdCard({ lines: lines('Name: Abdul Karim Rahman'), text: '' }).nameLatin?.value).toBe('ABDUL KARIM RAHMAN');
  });
});

describe('OCR parser — dates and nationality', () => {
  it('Hijri and Gregorian dates in both orders, assigned by their labels', () => {
    const card = parseIdCard({
      lines: lines('تاريخ الميلاد: 1410/05/12', 'تاريخ الانتهاء 2028-03-01'),
      text: '',
    });
    expect(card.birthDate).toMatchObject({ value: '1410-05-12', calendar: 'HIJRI' });
    expect(card.expiryDate).toMatchObject({ value: '2028-03-01', calendar: 'GREGORIAN' });
  });

  it('Arabic-Indic dates and dd/mm/yyyy; impossible dates are dropped', () => {
    expect(findDates(lines('الميلاد ١٢/٠٥/١٩٩٠')).map((d) => d.value)).toEqual(['1990-05-12']);
    expect(findDates(lines('31/02/1990 1990/13/01'))).toEqual([]);
  });

  it('unlabelled dates: earliest = birth, latest (≥ 2000) = expiry, with a lower confidence', () => {
    const card = parseIdCard({ lines: lines('1995/01/20', '1450/07/01'), text: '' });
    expect(card.birthDate?.value).toBe('1995-01-20');
    expect(card.expiryDate).toMatchObject({ value: '1450-07-01', calendar: 'HIJRI' });
    expect(card.birthDate!.confidence).toBeLessThan(90);
  });

  it('nationality: after «الجنسية», from the known list, or Saudi for an ID starting with 1', () => {
    expect(parseIdCard({ lines: lines('الجنسية: هندي'), text: '' }).nationality?.value).toBe('هندي');
    expect(parseIdCard({ lines: lines('Nationality: PAKISTAN'), text: '' }).nationality?.value).toBe('PAKISTAN');
    expect(parseIdCard({ lines: lines('عامل بنغلاديشي'), text: '' }).nationality?.value).toBe('بنغلاديشي');
    expect(parseIdCard({ lines: lines(CITIZEN), text: '' }).nationality).toEqual({ value: 'سعودي', confidence: 50 });
    expect(parseIdCard({ lines: lines(RESIDENT), text: '' }).nationality).toBeNull();
  });

  it('a full synthetic Iqama read: every field with a confidence', () => {
    const text = [
      'المملكة العربية السعودية',
      'وزارة الداخلية',
      'إقامة',
      'الاسم: راجيش كومار',
      'RAJESH KUMAR',
      `رقم الإقامة: ${RESIDENT.split('').join(' ')}`,
      'الجنسية: هندي',
      'تاريخ الميلاد ١٤٠٨/٠٣/١٥',
      'تاريخ الانتهاء ١٤٤٩/٠١/٠١',
    ].join('\n');
    const card = parseIdCard({ text });
    expect(card).toMatchObject({
      nationalId: { value: RESIDENT },
      name: { value: 'راجيش كومار' },
      nameLatin: { value: 'RAJESH KUMAR' },
      nationality: { value: 'هندي' },
      birthDate: { value: '1408-03-15', calendar: 'HIJRI' },
      expiryDate: { value: '1449-01-01', calendar: 'HIJRI' },
    });
    for (const f of [card.nationalId, card.name, card.nationality, card.birthDate, card.expiryDate]) {
      expect(f!.confidence).toBeGreaterThanOrEqual(0);
      expect(f!.confidence).toBeLessThanOrEqual(100);
    }
  });

  it('garbage in → empty fields, never a throw', () => {
    expect(parseIdCard({ text: '' })).toMatchObject({ nationalId: null, name: null, birthDate: null, expiryDate: null });
    expect(() => parseIdCard({ text: '@@@ ### \u0000 ١٢٣' })).not.toThrow();
  });
});

describe('name similarity (trigram Dice, pure JS)', () => {
  it('normalises alef/taa marbuta/alef maqsura and ignores word order', () => {
    expect(normaliseName('أحمد عيسى الزهراني')).toBe(normaliseName('احمد عيسي الزهراني'));
    expect(nameSimilarity('فاطمة علي', 'فاطمه علي')).toBe(1);
    expect(nameSimilarity('سعد محمد العتيبي', 'العتيبي سعد محمد')).toBe(1);
  });

  it('close OCR misreads score high, different people low', () => {
    expect(nameSimilarity('محمد عبدالله القحطاني', 'محمد عبد الله القحطانى')).toBeGreaterThan(0.6);
    expect(nameSimilarity('محمد عبدالله القحطاني', 'خالد سعيد الغامدي')).toBeLessThan(0.3);
  });

  it('rankByName keeps the best matches above the threshold', () => {
    const rows = [
      { id: 'a', fullName: 'محمد عبدالله القحطاني' },
      { id: 'b', fullName: 'خالد سعيد الغامدي' },
      { id: 'c', fullName: 'محمد عبدالله الشهري' },
    ];
    const ranked = rankByName('محمد عبد الله القحطانى', rows);
    expect(ranked.map((r) => r.id)).toEqual(['a', 'c']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
});
