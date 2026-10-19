#!/usr/bin/env node
/**
 * i18n guard (brief §12, skill nuzli-arabic-rtl). Fails when:
 *   1. a key exists in ar.ts but not in en.ts, or the other way round;
 *   2. an Arabic string is empty;
 *   3. a .tsx file contains JSX text with Latin letters, or a user-visible JSX
 *      attribute (label, placeholder, title, aria-label, alt, description, error)
 *      given as a Latin string literal.
 * Usage: node scripts/check-i18n.mjs   (exit code 0 = clean)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const LATIN = /[A-Za-z]/;
const VISIBLE_ATTRS = new Set([
  'label',
  'placeholder',
  'title',
  'aria-label',
  'alt',
  'description',
  'error',
]);

function dictionary(file) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const entries = new Map();
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))
    ) {
      const value =
        ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)
          ? node.initializer.text
          : null;
      entries.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return entries;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

const problems = [];

// 1–2. Keys
const ar = dictionary(join(src, 'i18n', 'ar.ts'));
const en = dictionary(join(src, 'i18n', 'en.ts'));
for (const key of ar.keys()) if (!en.has(key)) problems.push(`en.ts: missing key "${key}"`);
for (const key of en.keys()) if (!ar.has(key)) problems.push(`ar.ts: missing key "${key}"`);
for (const [key, value] of ar)
  if (!value || !value.trim()) problems.push(`ar.ts: empty value for "${key}"`);
// A10 QA: digits are Western by default and Arabic-Indic only by the user's setting, which formats
// NUMBERS; a digit typed into a message would ignore it («آخر ٣٠ يومًا»). Only the setting's own sample keeps them.
for (const [key, value] of ar)
  if (key !== 'profile.digits.arab' && /[٠-٩]/.test(value)) problems.push(`ar.ts: "${key}" has Arabic-Indic digits typed in — write Western digits or pass a number`);

// 3. Latin text in JSX
for (const file of walk(src)) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const where = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${relative(root, file).replace(/\\/g, '/')}:${line + 1}`;
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const value = node.text.trim();
      if (value && LATIN.test(value))
        problems.push(`${where(node)}: Latin JSX text "${value.slice(0, 60)}"`);
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(sf);
      if (VISIBLE_ATTRS.has(name) && LATIN.test(node.initializer.text)) {
        problems.push(
          `${where(node)}: Latin text in ${name}="${node.initializer.text.slice(0, 60)}"`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// 4. Arabic plural agreement (calculations audit M5). A message where a number placeholder is
//    followed by a counted noun («{count} مهمة», «{n} يوم») must have its plural forms
//    (`key.one`, `key.two`, `key.few`, `key.many`; `key` itself is "other"), and its callers must
//    use tCount(key, number) — never t(key, …) and never a pre-formatted string.
const FORMS = ['zero', 'one', 'two', 'few', 'many'];
const NUMERIC = new Set(['count', 'n', 'days', 'hours', 'minutes', 'seconds', 'links', 'tasks', 'max', 'positions', 'teams', 'members', 'rows', 'units', 'vacant', 'unread']);
// Words that may follow a number without being a counted noun (adjectives, units, prepositions).
const NOT_A_NOUN = /^(غير|أخرى|من|جديدة|بانتظار|صحيح|فيه|م|ك|و|مع|ميغابايت|٪|←)$/;
// Messages whose number is a fixed constant in the "other" form (5000 = «٥٠٠٠ مهمة»).
const CONSTANT_COUNT = new Set(['import.file.limit']);
const isForm = (key) => FORMS.some((f) => key.endsWith(`.${f}`));
const pluralKeys = new Set();
for (const [key, value] of ar) {
  if (isForm(key) || !value) continue;
  const hasForms = ['one', 'two', 'few', 'many'].every((f) => ar.has(`${key}.${f}`));
  if (hasForms) pluralKeys.add(key);
  if (CONSTANT_COUNT.has(key)) continue;
  for (const m of value.matchAll(/\{(\w+)\}\s*([؀-ۿ][^\s،.:؛){]*)/g)) {
    if (!NUMERIC.has(m[1]) || NOT_A_NOUN.test(m[2])) continue;
    if (!hasForms) problems.push(`ar.ts: "${key}" counts a noun («{${m[1]}} ${m[2]}») without plural forms (.one/.two/.few/.many)`);
  }
}
for (const key of pluralKeys) {
  for (const f of ['one', 'two', 'few', 'many']) if (!ar.get(`${key}.${f}`)?.trim()) problems.push(`ar.ts: empty plural form "${key}.${f}"`);
}
function walkCode(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCode(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) && !p.includes(`${join('src', 'i18n')}`)) out.push(p);
  }
  return out;
}
for (const file of walkCode(src)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file).replace(/\\/g, '/');
  for (const m of text.matchAll(/\bt\('([^']+)'/g)) {
    if (pluralKeys.has(m[1])) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${rel}:${line}: "${m[1]}" has plural forms — call tCount('${m[1]}', number)`);
    }
  }
  for (const m of text.matchAll(/\btCount\([^,]+,\s*formatNumber\(/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`${rel}:${line}: tCount() needs the number, not a formatted string`);
  }
}

if (problems.length) {
  console.error(`i18n check failed (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`i18n check passed: ${ar.size} keys in ar/en, no Latin JSX text, ${pluralKeys.size} count messages with plural forms.`);
