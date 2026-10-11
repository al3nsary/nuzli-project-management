import { Body, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import type { AnyZodObject, ZodTypeAny } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

type Check = { kind: string; value?: number };

/**
 * Minimal zod → OpenAPI converter so Swagger is generated from the same shared schemas
 * that validate requests (ADR-003). Covers the zod features used in @nuzli/shared.
 */
export function zodToOpenApi(schema: ZodTypeAny): SchemaObject {
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as AnyZodObject).shape as Record<string, ZodTypeAny>;
      const properties: Record<string, SchemaObject> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToOpenApi(value);
        if (!value.isOptional()) required.push(key);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'ZodString': {
      const out: SchemaObject = { type: 'string' };
      for (const check of (def.checks as Check[] | undefined) ?? []) {
        if (check.kind === 'email') out.format = 'email';
        if (check.kind === 'uuid') out.format = 'uuid';
        if (check.kind === 'datetime') out.format = 'date-time';
        if (check.kind === 'min') out.minLength = check.value;
        if (check.kind === 'max') out.maxLength = check.value;
      }
      return out;
    }
    case 'ZodNumber': {
      const checks = (def.checks as Check[] | undefined) ?? [];
      const out: SchemaObject = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') out.minimum = c.value;
        if (c.kind === 'max') out.maximum = c.value;
      }
      return out;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])] };
    case 'ZodNativeEnum':
      return { type: 'string', enum: Object.values(def.values as object) };
    case 'ZodLiteral':
      return { enum: [def.value] };
    case 'ZodArray':
      return { type: 'array', items: zodToOpenApi(def.type as ZodTypeAny) };
    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToOpenApi(def.valueType as ZodTypeAny) };
    case 'ZodOptional':
      return zodToOpenApi(def.innerType as ZodTypeAny);
    case 'ZodNullable':
      return { ...zodToOpenApi(def.innerType as ZodTypeAny), nullable: true };
    case 'ZodDefault':
      return {
        ...zodToOpenApi(def.innerType as ZodTypeAny),
        default: (def.defaultValue as () => unknown)(),
      };
    case 'ZodEffects':
      return zodToOpenApi(def.schema as ZodTypeAny);
    case 'ZodPipeline':
      return zodToOpenApi(def.in as ZodTypeAny);
    case 'ZodUnion':
      return { oneOf: (def.options as ZodTypeAny[]).map(zodToOpenApi) };
    default:
      return {};
  }
}

function decorateMethod(target: object, key: string | symbol | undefined, decorator: MethodDecorator) {
  if (key === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor) decorator(target, key, descriptor);
}

/** `@ZodBody(schema) body` — validates the body with the shared schema and documents it. */
export function ZodBody(schema: ZodTypeAny): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodValidationPipe(schema))(target, key, index);
    decorateMethod(target, key, ApiBody({ schema: zodToOpenApi(schema) }));
  };
}

/** `@ZodQuery(schema) query` — validates the query string and documents every parameter. */
export function ZodQuery(schema: AnyZodObject): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodValidationPipe(schema))(target, key, index);
    for (const [name, value] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
      decorateMethod(
        target,
        key,
        ApiQuery({ name, required: !value.isOptional(), schema: zodToOpenApi(value) }),
      );
    }
  };
}
