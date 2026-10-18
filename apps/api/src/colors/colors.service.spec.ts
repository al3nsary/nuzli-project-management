import { Prisma } from '@prisma/client';
import { AppError } from '../common/app-error';
import { mapPrismaError } from '../common/prisma-errors';
import { availableColors, ColorsService } from './colors.service';

const color = (id: string, isActive = true) => ({ id, name: `لون ${id}`, hex: '#112233', isActive });

describe('available colours (brief §5.2)', () => {
  const palette = [color('c1'), color('c2'), color('c3'), color('c4', false)];
  const reserving = [
    { id: 't1', name: 'فريق ١', colorId: 'c1' }, // ACTIVE team
    { id: 't2', name: 'فريق ٢', colorId: 'c2' }, // PENDING_APPROVAL team — still reserved
  ];

  it('never returns a colour held by an ACTIVE or PENDING_APPROVAL team, nor a retired one', () => {
    expect(availableColors(palette, reserving).map((c) => c.id)).toEqual(['c3']);
  });

  it("includes the edited team's own colour when excludeTeamId is given", () => {
    expect(availableColors(palette, reserving, 't1').map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it("keeps the edited team's colour even after it was retired from the palette", () => {
    const withRetired = [...reserving, { id: 't3', name: 'فريق ٣', colorId: 'c4' }];
    expect(availableColors(palette, withRetired, 't3').map((c) => c.id)).toEqual(['c3', 'c4']);
  });

  it('an unknown excludeTeamId changes nothing', () => {
    expect(availableColors(palette, reserving, 'nope').map((c) => c.id)).toEqual(['c3']);
  });

  it('service: a supervisor cannot "keep" the colour of a team they do not lead', async () => {
    const prisma = {
      team: {
        findUnique: jest.fn().mockResolvedValue({ supervisors: [{ userId: 'someone-else' }] }),
        findMany: jest.fn().mockResolvedValue(reserving),
      },
      teamColor: { findMany: jest.fn().mockResolvedValue(palette) },
    };
    const svc = new ColorsService(prisma as never, {} as never);
    const sup = { id: 's1', role: 'SUPERVISOR' as const, status: 'ACTIVE' };
    expect((await svc.available('t1', sup)).map((c) => c.id)).toEqual(['c3']);
    prisma.team.findUnique.mockResolvedValue({ supervisors: [{ userId: 's1' }] });
    expect((await svc.available('t1', sup)).map((c) => c.id)).toEqual(['c1', 'c3']);
  });
});

describe('COLOR_TAKEN mapping', () => {
  const p2002 = (target: unknown) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target },
    });

  it('maps the partial unique index violation to 409 COLOR_TAKEN', () => {
    for (const target of ['teams_color_reserved_uq', ['color_id']]) {
      const err = mapPrismaError(p2002(target));
      expect(err?.code).toBe('COLOR_TAKEN');
      expect(err?.status).toBe(409);
    }
  });

  it('a duplicate palette hex is COLOR_EXISTS, a duplicate name NAME_TAKEN', () => {
    expect(mapPrismaError(p2002(['hex']))?.code).toBe('COLOR_EXISTS');
    expect(mapPrismaError(p2002('card_sizes_name_key'))?.code).toBe('NAME_TAKEN');
  });

  it('colorTakenError tells the client to refresh, with the fresh list', async () => {
    const prisma = {
      team: { findMany: jest.fn().mockResolvedValue([{ id: 't1', name: 'x', colorId: 'c1' }]) },
      teamColor: { findMany: jest.fn().mockResolvedValue([color('c1'), color('c2')]) },
    };
    const err = await new ColorsService(prisma as never, {} as never).colorTakenError();
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('COLOR_TAKEN');
    expect(err.details).toMatchObject({ refresh: 'colors', fieldErrors: { colorId: [expect.any(String)] } });
    expect((err.details as { available: Array<{ id: string }> }).available.map((c) => c.id)).toEqual(['c2']);
  });
});
