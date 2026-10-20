#!/usr/bin/env node
/**
 * A12: regenerates every src/i18n/parts/<name>.en.ts from <name>.ar.ts (same keys, English left
 * empty — brief §12: "ar complete; en scaffolded"). Run after adding Arabic strings to a part.
 * Usage: node scripts/sync-en-parts.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'parts');
for (const file of readdirSync(dir).filter((n) => n.endsWith('.ar.ts'))) {
  const name = file.slice(0, -'.ar.ts'.length);
  const text = readFileSync(join(dir, file), 'utf8');
  const exportName = /export const (\w+)/.exec(text)?.[1];
  if (!exportName) continue;
  const enName = exportName.replace(/^ar/, 'en');
  const keys = [...text.matchAll(/^\s+'([^']+)':/gm)].map((m) => m[1]);
  const body = keys.map((k) => `  '${k}': '',`).join('\n');
  writeFileSync(
    join(dir, `${name}.en.ts`),
    `import type { ${exportName} } from './${name}.ar';\n\n/** English scaffold (brief §12): same keys as ${name}.ar.ts. */\nexport const ${enName}: Record<keyof typeof ${exportName}, string> = {\n${body}\n};\n`,
  );
  console.log(`${name}: ${keys.length} keys`);
}
