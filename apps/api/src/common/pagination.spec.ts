import { parseSort, withIdTiebreak } from './pagination';

describe('calculations audit L5 — offset pagination has a unique tiebreaker', () => {
  it('appends { id: asc } after the requested order', () => {
    expect(withIdTiebreak(parseSort('fullName:desc', ['fullName'] as const, { fullName: 'asc' }))).toEqual([{ fullName: 'desc' }, { id: 'asc' }]);
    expect(withIdTiebreak([{ at: 'desc' as const }])).toEqual([{ at: 'desc' }, { id: 'asc' }]);
  });
});
