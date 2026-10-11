import { BadRequestException, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { ERRORS, registerSchema } from '@nuzli/shared';
import { AppError } from './app-error';
import { AllExceptionsFilter, toErrorResponse } from './error.filter';
import { ZodValidationPipe } from './zod-validation.pipe';

function p2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target },
  });
}

describe('error filter: one shape { code, message_ar, details }', () => {
  it('maps AppError with its status and Arabic message', () => {
    const { status, body } = toErrorResponse(new AppError('LAST_ADMIN'));
    expect(status).toBe(409);
    expect(body).toEqual({ code: 'LAST_ADMIN', message_ar: ERRORS.LAST_ADMIN });
  });

  it('keeps details', () => {
    const { body } = toErrorResponse(new AppError('VALIDATION_FAILED', { fieldErrors: { a: ['x'] } }));
    expect(body.details).toEqual({ fieldErrors: { a: ['x'] } });
  });

  it('maps Prisma unique violations on email / mobile / national_id_hash', () => {
    expect(toErrorResponse(p2002(['email'])).body.code).toBe('EMAIL_TAKEN');
    expect(toErrorResponse(p2002(['mobile'])).body.code).toBe('MOBILE_TAKEN');
    expect(toErrorResponse(p2002(['national_id_hash'])).body.code).toBe('NATIONAL_ID_TAKEN');
    expect(toErrorResponse(p2002(['national_id_hash'])).status).toBe(409);
  });

  it('maps Nest HTTP exceptions and throttling', () => {
    expect(toErrorResponse(new NotFoundException()).body.code).toBe('NOT_FOUND');
    expect(toErrorResponse(new BadRequestException('bad json')).body.code).toBe('VALIDATION_FAILED');
    const t = toErrorResponse(new ThrottlerException());
    expect(t.status).toBe(429);
    expect(t.body.code).toBe('RATE_LIMITED');
  });

  it('hides unknown errors behind INTERNAL / 500', () => {
    const { status, body } = toErrorResponse(new Error('secret stack detail'));
    expect(status).toBe(500);
    expect(body).toEqual({ code: 'INTERNAL', message_ar: ERRORS.INTERNAL });
  });

  it('writes the JSON response', () => {
    const json = jest.fn();
    const res = { headersSent: false, status: jest.fn().mockReturnValue({ json }) };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    new AllExceptionsFilter().catch(new AppError('FORBIDDEN'), host);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ code: 'FORBIDDEN', message_ar: ERRORS.FORBIDDEN });
  });
});

describe('ZodValidationPipe', () => {
  it('maps zod issues to details.fieldErrors with Arabic messages', () => {
    const pipe = new ZodValidationPipe(registerSchema);
    try {
      pipe.transform({ accountType: 'ADMIN', email: 'nope', mobile: '123', nationalId: '1', password: 'x' });
      fail('should throw');
    } catch (e) {
      const { status, body } = toErrorResponse(e);
      expect(status).toBe(400);
      expect(body.code).toBe('VALIDATION_FAILED');
      const fe = (body.details as { fieldErrors: Record<string, string[]> }).fieldErrors;
      expect(Object.keys(fe)).toEqual(
        expect.arrayContaining(['accountType', 'fullName', 'email', 'mobile', 'nationalId', 'password']),
      );
      expect(fe.mobile?.[0]).toMatch(/جوال/);
    }
  });

  it('returns the parsed (normalised) value', () => {
    const pipe = new ZodValidationPipe(registerSchema);
    const out = pipe.transform({
      accountType: 'MONITOR',
      fullName: 'سعد المطيري',
      email: 'Saad@Example.SA',
      mobile: '0512345678',
      nationalId: '1000000008',
      password: 'Password123',
    });
    expect(out.email).toBe('saad@example.sa');
    expect(out.mobile).toBe('+966512345678');
  });
});
