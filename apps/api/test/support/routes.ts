/**
 * A12: every HTTP route of the API, read from Nest's metadata (controllers registered in the
 * AppModule). The isolation suite fails when a route has no isolation case, so a new endpoint
 * cannot ship without one.
 */
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { IS_PUBLIC, WORKSPACE_OPTIONAL } from '../../src/common/decorators';

export interface RouteInfo {
  /** e.g. "GET /teams/:id" (without the /api/v1 prefix). */
  key: string;
  method: string;
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  workspaceOptional: boolean;
}

function join(...parts: string[]): string {
  const p = parts
    .flatMap((x) => x.split('/'))
    .filter(Boolean)
    .join('/');
  return `/${p}`;
}

export function listRoutes(app: INestApplication): RouteInfo[] {
  const modules = app.get(ModulesContainer);
  const out: RouteInfo[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as (new (...a: unknown[]) => unknown) | undefined;
      if (!cls) continue;
      const base = (Reflect.getMetadata(PATH_METADATA, cls) as string | string[] | undefined) ?? '';
      const bases = Array.isArray(base) ? base : [base];
      const classPublic = !!Reflect.getMetadata(IS_PUBLIC, cls);
      const classOptional = !!Reflect.getMetadata(WORKSPACE_OPTIONAL, cls);
      const proto = cls.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const fn = proto[name];
        if (typeof fn !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, fn) as string | string[] | undefined;
        const method = Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined;
        if (sub === undefined || method === undefined) continue;
        for (const b of bases) {
          for (const s of Array.isArray(sub) ? sub : [sub]) {
            const path = join(b, s);
            const m = RequestMethod[method];
            out.push({
              key: `${m} ${path}`,
              method: m,
              path,
              controller: cls.name,
              handler: name,
              isPublic: classPublic || !!Reflect.getMetadata(IS_PUBLIC, fn),
              workspaceOptional: classOptional || !!Reflect.getMetadata(WORKSPACE_OPTIONAL, fn),
            });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
