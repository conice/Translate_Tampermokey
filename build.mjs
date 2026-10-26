#!/usr/bin/env node
// Zero-dependency bundler.
//
// The repo lives on a FUSE mount that does not support symlinks, so npm cannot
// install a real bundler here. Every module in src/ uses the same narrow ESM
// subset: named imports from relative paths, and `export` on declarations.
// Each module is wrapped in its own IIFE so that identically-named locals
// (two modules both declaring STYLE) cannot collide.

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(ROOT, 'src/main.js');
const OUT = resolve(ROOT, 'dist/translate-tampermokey.user.js');

const META = `// ==UserScript==
// @name         Translate Tampermokey
// @namespace    https://github.com/local/translate-tampermokey
// @version      0.1.0
// @description  双击取词弹窗翻译,收藏进生词本,生词本词条以注音形式常驻原文右侧
// @author       local
// @match        *://*/*
// @exclude      *://localhost/*
// @exclude      *://127.0.0.1/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      clients5.google.com
// @connect      api.mymemory.translated.net
// @connect      lingva.ml
// @connect      api.dictionaryapi.dev
// @connect      freedictionaryapi.com
// @run-at       document-idle
// @noframes
// ==/UserScript==
`;

const IMPORT_RE = /^import\s*(?:\{([^}]*)\}|(\w+))\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(?:async\s+)?(function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;

async function collect(file, seen, order) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    await collect(resolve(dirname(file), match[3]), seen, order);
  }
  order.push({ file, source });
  return order;
}

function moduleId(file) {
  return `__mod_${relative(resolve(ROOT, 'src'), file)
    .replace(/\.js$/, '')
    .replace(/[^\w]/g, '_')}`;
}

function transform(file, source, ids) {
  const exported = new Set();
  const imports = [];

  let code = source.replace(IMPORT_RE, (_full, braces, defaultName, spec) => {
    const target = ids.get(resolve(dirname(file), spec));
    if (!target) throw new Error(`${relative(ROOT, file)}: unresolved import ${spec}`);
    const names = [];
    if (braces) {
      for (const raw of braces.split(',')) {
        const name = raw.trim();
        if (!name) continue;
        if (name.includes(' as ')) {
          const [from, to] = name.split(/\s+as\s+/).map((s) => s.trim());
          names.push(`${from}: ${to}`);
        } else {
          names.push(name);
        }
      }
    }
    if (defaultName) names.push(`default: ${defaultName}`);
    imports.push(`const { ${names.join(', ')} } = ${target};`);
    return '';
  });

  code = code.replace(EXPORT_LIST_RE, (_full, list) => {
    for (const raw of list.split(',')) {
      const name = raw.trim();
      if (name) exported.add(name);
    }
    return '';
  });

  code = code.replace(EXPORT_DECL_RE, (_full, kind, name) => {
    exported.add(name);
    return `${kind === 'function*' ? 'function*' : kind} ${name}`;
  });

  const leftovers = code
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter(({ line }) => /^(?:import|export)\s/.test(line));
  if (leftovers.length > 0) {
    const where = leftovers.map(({ line, index }) => `  ${relative(ROOT, file)}:${index} ${line}`).join('\n');
    throw new Error(`unsupported import/export syntax:\n${where}`);
  }

  const exportLines = [...exported].map((name) => `    ${name},`).join('\n');
  return `${moduleId(file)} = (function () {
${imports.join('\n')}
${code.trim()}

  return {
${exportLines}
  };
})();`;
}

const seen = new Set();
const order = await collect(ENTRY, seen, []);
const ids = new Map(order.map(({ file }) => [file, moduleId(file)]));

const declarations = order.map(({ file }) => `let ${moduleId(file)};`).join('\n');
const body = order
  .map(({ file, source }) => `// ---- ${relative(ROOT, file)} ----\n${transform(file, source, ids)}`)
  .join('\n\n');

const output = `${META}

(function () {
  'use strict';

${declarations}

${body}
})();
`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, output, 'utf8');
console.log(`built ${relative(ROOT, OUT)} (${order.length} modules, ${Buffer.byteLength(output)} bytes)`);