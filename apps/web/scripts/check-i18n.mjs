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

if (problems.length) {
  console.error(`i18n check failed (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`i18n check passed: ${ar.size} keys in ar/en, no Latin JSX text.`);
