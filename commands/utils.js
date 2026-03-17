// ─── Shared Utilities ─────────────────────────────────────────────
// Common functions used by next-init.js, next-update.js, and next-plan.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef',
  'useContext', 'useReducer', 'useLayoutEffect', 'useTransition',
  'useDeferredValue', 'useId', 'useImperativeHandle', 'useDebugValue',
  'useOptimistic', 'useFormStatus', 'useFormState',
]);

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// ─── File Hash (MD5, 8 chars) ────────────────────────────────────
function hashContent(content) {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

// ─── Extract export names from file ──────────────────────────────
function extractExports(content) {
  const exports = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:const|let|var)\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+(?:type|interface)\s+(\w+)/g,
    /export\s*\{([^}]+)\}/g,
  ];
  for (const pattern of patterns) {
    for (const m of content.matchAll(pattern)) {
      if (pattern.source.includes('\\{')) {
        m[1].split(',').forEach(part => {
          const name = part.trim().split(/\s+as\s+/).pop().trim();
          if (name && name !== 'default') exports.add(name);
        });
      } else {
        if (m[1] !== 'default') exports.add(m[1]);
      }
    }
  }
  if (/export\s+default\s+(?:function|class)/.test(content)) exports.add('default');
  return [...exports];
}

// ─── Component type classification (name-based heuristic) ────────
const COMP_TYPE_MAP = [
  ['Modal',   /modal|dialog|popup/i],
  ['Form',    /form/i],
  ['Button',  /button|btn/i],
  ['Card',    /card/i],
  ['Table',   /table|grid/i],
  ['List',    /list/i],
  ['Input',   /input|field|textarea/i],
  ['Layout',  /layout/i],
  ['Nav',     /nav|navbar|sidebar|menu/i],
  ['Page',    /page/i],
];

function detectComponentType(name) {
  for (const [type, pattern] of COMP_TYPE_MAP) {
    if (pattern.test(name)) return type;
  }
  return null;
}

// ─── Extract Props via TypeScript Compiler API ───────────────────
// Uses the project's node_modules/typescript (no extra dependency needed)
function extractProps(content, filename, projectRoot) {
  let ts;
  try {
    ts = require(path.join(projectRoot, 'node_modules', 'typescript'));
  } catch {
    try { ts = require('typescript'); } catch { return []; }
  }
  try {
    const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true);
    const props = [];
    ts.forEachChild(source, node => {
      // interface XxxProps { prop: type; ... }
      if (ts.isInterfaceDeclaration(node) && node.name.text.endsWith('Props')) {
        node.members.forEach(m => {
          if (m.name) props.push(m.name.getText(source));
        });
      }
      // type XxxProps = { prop: type; ... }
      if (ts.isTypeAliasDeclaration(node) && node.name.text.endsWith('Props') && ts.isTypeLiteral(node.type)) {
        node.type.members.forEach(m => {
          if (m.name) props.push(m.name.getText(source));
        });
      }
    });
    return props;
  } catch { return []; }
}

// ─── File metadata analysis (directives, exports, hooks, deps, hash, length, lines, props)
function analyzeFile(content, filePath, aliasPrefixes = [], projectRoot = null) {
  const hash = hashContent(content);
  const lines = content.split('\n').length;
  const length = Buffer.byteLength(content, 'utf-8');

  const directives = [];
  if (/^\s*['"]use client['"]/m.test(content)) directives.push('use client');
  if (/^\s*['"]use server['"]/m.test(content)) directives.push('use server');

  const exports = extractExports(content);

  // hooks
  const hookSet = new Set();
  for (const m of content.matchAll(/\b(use[A-Z]\w+)\s*\(/g)) {
    if (REACT_HOOKS.has(m[1])) hookSet.add(m[1]);
  }
  const hooks = [...hookSet];

  // external deps
  const typeOnlyFromPattern = /import\s+type\s+.*?from\s+['"]([^'"]+)['"]/g;
  const fromPattern = /from\s+['"]([^'"]+)['"]/g;
  const typeOnlySpecs = new Set();
  for (const m of content.matchAll(typeOnlyFromPattern)) typeOnlySpecs.add(m[1]);

  const depSet = new Set();
  for (const m of content.matchAll(fromPattern)) {
    const spec = m[1];
    if (spec.startsWith('.')) continue;
    const isAlias = aliasPrefixes.some(({ aliasPrefix }) => spec.startsWith(aliasPrefix));
    if (isAlias) continue;
    const pkg = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    depSet.add(pkg);
  }
  const deps = [...depSet];

  // props: parse XxxProps interface/type via TypeScript compiler (only when projectRoot given)
  const props = projectRoot ? extractProps(content, path.basename(filePath), projectRoot) : [];

  // type: classify component by name (first PascalCase export)
  const componentName = exports.find(e => e !== 'default' && /^[A-Z]/.test(e)) ?? null;
  const type = componentName ? detectComponentType(componentName) : null;

  return { hash, lines, length, directives, exports, hooks, deps, props, type };
}

// ─── Recompute importedBy for a single file ──────────────────────
// Scans all filesJson entries to find files that import targetRel
function computeImportedBy(targetRel, filesJson, aliasPrefixes, projectRoot) {
  const importedBy = [];
  const namedImportPattern = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
  const defaultImportPattern = /import\s+(type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/g;
  const typeOnlyFromPattern = /import\s+type\s+.*?from\s+['"]([^'"]+)['"]/g;

  for (const importerRel of Object.keys(filesJson)) {
    const ext = path.extname(importerRel);
    if (!SOURCE_EXTS.has(ext)) continue;

    let content;
    try {
      content = fs.readFileSync(path.join(projectRoot, importerRel), 'utf-8');
    } catch { continue; }

    const typeOnlySpecs = new Set();
    for (const m of content.matchAll(typeOnlyFromPattern)) typeOnlySpecs.add(m[1]);

    const namedBySpec = new Map();
    for (const m of content.matchAll(namedImportPattern)) {
      const isTypeOnly = !!m[1] || typeOnlySpecs.has(m[3]);
      const names = m[2].split(',').map(p => p.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
      const spec = m[3];
      if (!namedBySpec.has(spec)) namedBySpec.set(spec, { names: new Set(), typeOnly: isTypeOnly });
      names.forEach(n => namedBySpec.get(spec).names.add(n));
    }
    for (const m of content.matchAll(defaultImportPattern)) {
      const isTypeOnly = !!m[1] || typeOnlySpecs.has(m[3]);
      const spec = m[3];
      if (!namedBySpec.has(spec)) namedBySpec.set(spec, { names: new Set(), typeOnly: isTypeOnly });
      namedBySpec.get(spec).names.add('default');
    }

    // Resolve each import spec and check if it matches targetRel
    for (const [spec, { names, typeOnly }] of namedBySpec) {
      const resolvedList = resolveSpec(spec, importerRel, aliasPrefixes);
      if (!resolvedList) continue;

      // extension candidates for all resolved paths
      const candidates = resolvedList.flatMap(resolved =>
        path.extname(resolved)
          ? [resolved]
          : [
              resolved + '.ts', resolved + '.tsx',
              resolved + '.js', resolved + '.jsx',
              resolved + '/index.ts', resolved + '/index.tsx',
              resolved + '/index.js', resolved + '/index.jsx',
            ]
      );

      if (candidates.includes(targetRel)) {
        const named = [...names].filter(n => n !== 'default');
        importedBy.push({ importer: importerRel, named, typeOnly });
        break;
      }
    }
  }

  return importedBy;
}

// ─── Resolve import spec to relative path ────────────────────────
function resolveSpec(spec, importerRel, aliasPrefixes) {
  if (spec.startsWith('.')) {
    const importerDir = path.dirname(importerRel);
    return [path.normalize(importerDir + '/' + spec).replace(/\\/g, '/').replace(/^\.\//, '')];
  }
  const results = [];
  for (const { aliasPrefix, targetPrefix } of aliasPrefixes) {
    if (spec.startsWith(aliasPrefix)) {
      results.push((targetPrefix + spec.slice(aliasPrefix.length)).replace(/^\.\//, ''));
    }
  }
  return results.length > 0 ? results : null;
}

// ─── Convert tsconfig alias to aliasPrefixes array ───────────────
function buildAliasPrefixes(aliasMap) {
  if (!aliasMap) return [];
  return aliasMap.map(({ alias, target }) => ({
    aliasPrefix: alias.replace(/\*$/, ''),
    targetPrefix: target.replace(/^\.\//, '').replace(/\/$/, '') + '/',
  }));
}

// ─── Determine group key ────────────────────────────────────────
function groupKey(relPath, hasSrc) {
  const segments = relPath.split('/');
  if (hasSrc && segments[0] === 'src' && segments.length > 2) return segments[1];
  return segments[0].includes('.') ? '(root)' : segments[0];
}

// ─── Remove entries for deleted files + clean up importedBy ──────
function pruneDeleted(filesJson, projectRoot) {
  const deleted = Object.keys(filesJson).filter(
    p => !fs.existsSync(path.join(projectRoot, p))
  );
  for (const p of deleted) {
    delete filesJson[p];
    for (const entry of Object.values(filesJson)) {
      entry.importedBy = entry.importedBy.filter(e => e.importer !== p);
    }
  }
  return deleted;
}

// ─── Discover source files on disk not yet in filesJson ──────────
function discoverNewFiles(filesJson, aliasPrefixes, projectRoot) {
  const IGNORE = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build', '.turbo', '.vercel']);
  const hasSrc = fs.existsSync(path.join(projectRoot, 'src'));
  const now = new Date().toISOString();
  let found = false;

  function walk(dir, relDir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (IGNORE.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (SOURCE_EXTS.has(path.extname(entry.name)) && !filesJson[relPath]) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const { hash, lines, length, directives, exports, hooks, deps, props, type } = analyzeFile(content, relPath, aliasPrefixes, projectRoot);
          filesJson[relPath] = {
            group: groupKey(relPath, hasSrc),
            createdAt: now, updatedAt: now, hash,
            length: { baseline: length, current: length },
            lines: { baseline: lines, current: lines },
            directives, exports, hooks, deps, props, type,
            importedBy: computeImportedBy(relPath, filesJson, aliasPrefixes, projectRoot),
          };
          found = true;
        } catch {}
      }
    }
  }
  walk(projectRoot, '');
  return found;
}

// ─── Parse .gitignore ────────────────────────────────────────────
function gitignored(projectRoot) {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return [];
  return fs.readFileSync(gitignorePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

// ─── Generate file tree ──────────────────────────────────────────
function tree(dir, ignored, prefix = '') {
  const ALWAYS_IGNORE = ['node_modules', '.next', '.git', '.claude'];
  let entries;
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return '';
  }

  const filtered = entries.filter(name => {
    if (ALWAYS_IGNORE.includes(name)) return false;
    return !ignored.some(pattern => {
      const clean = pattern.replace(/\/$/, '');
      return name === clean || name.startsWith(clean + '/');
    });
  });

  return filtered.map((name, i) => {
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const fullPath = path.join(dir, name);
    const isDir = fs.statSync(fullPath).isDirectory();
    const line = prefix + connector + name + (isDir ? '/' : '');
    if (isDir) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      return line + '\n' + tree(fullPath, ignored, childPrefix);
    }
    return line;
  }).join('\n');
}

// ─── Load tsconfig alias (shared) ────────────────────────────────
function loadAliasPrefixes(projectRoot) {
  try {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    if (!fs.existsSync(tsconfigPath)) return [];
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    const paths = tsconfig?.compilerOptions?.paths;
    if (!paths) return [];
    const aliasMap = Object.entries(paths).flatMap(([alias, targets]) =>
      targets.map(t => ({ alias, target: t.replace('/*', '') }))
    );
    return buildAliasPrefixes(aliasMap);
  } catch { return []; }
}

module.exports = {
  REACT_HOOKS,
  SOURCE_EXTS,
  hashContent,
  extractExports,
  extractProps,
  detectComponentType,
  analyzeFile,
  computeImportedBy,
  resolveSpec,
  buildAliasPrefixes,
  loadAliasPrefixes,
  groupKey,
  pruneDeleted,
  discoverNewFiles,
  gitignored,
  tree,
};
