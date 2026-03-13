#!/usr/bin/env node
// ─── next-update.js ──────────────────────────────────────────────
// PostToolUse Hook script — incrementally updates only the modified file entry in files.json
// stdin: { tool_name, tool_input: { file_path } }

const fs = require('fs');
const path = require('path');
const { analyzeFile, computeImportedBy, resolveSpec, loadAliasPrefixes, groupKey, SOURCE_EXTS, pruneDeleted, discoverNewFiles } = require('./utils');

const projectRoot = fs.realpathSync(process.cwd());
const claudeDir = path.join(projectRoot, '.claude');
const filesJsonPath = path.join(claudeDir, 'files.json');

async function main() {
  // Read hook payload from stdin
  let payload = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) payload += chunk;

  let hookData;
  try {
    hookData = JSON.parse(payload);
  } catch {
    process.exit(0); // Exit silently on JSON parse failure
  }

  // Ignore if files.json doesn't exist (next-init must run first)
  if (!fs.existsSync(filesJsonPath)) process.exit(0);

  let filesJson;
  try {
    filesJson = JSON.parse(fs.readFileSync(filesJsonPath, 'utf-8'));
  } catch {
    process.exit(0);
  }

  const aliasPrefixes = loadAliasPrefixes(projectRoot);

  // ── Bash tool: handle commands that may delete/create files
  if (hookData?.tool_name === 'Bash') {
    const cmd = hookData?.tool_input?.command ?? '';
    const mightDelete = /\b(rm|mv|rimraf|del|git\s+(checkout|clean|rm|mv|stash\s+pop|merge|pull))\b/.test(cmd);
    const mightCreate = /\b(cp|mv|touch|git\s+(checkout|merge|pull|stash\s+pop|cherry-pick))\b/.test(cmd);
    let changed = false;

    if (mightDelete) {
      pruneDeleted(filesJson, projectRoot);
      changed = true;
    }
    if (mightCreate) {
      changed = discoverNewFiles(filesJson, aliasPrefixes, projectRoot) || changed;
    }
    if (changed) {
      fs.writeFileSync(filesJsonPath, JSON.stringify(filesJson, null, 2), 'utf-8');
    }
    process.exit(0);
  }

  // ── Write/Edit tool: extract file path
  let absFilePath = hookData?.tool_input?.file_path;
  if (!absFilePath) process.exit(0);
  try { absFilePath = fs.realpathSync(absFilePath); } catch {}

  // Convert absolute path to project-root-relative path
  let relPath = path.relative(projectRoot, absFilePath).replace(/\\/g, '/');
  // Ignore files outside the project
  if (relPath.startsWith('..')) process.exit(0);

  // Ignore non-source files
  if (!SOURCE_EXTS.has(path.extname(relPath))) process.exit(0);

  // Read file content
  let content = '';
  try {
    content = fs.readFileSync(absFilePath, 'utf-8');
  } catch {
    // File was deleted: cleanup and exit
    pruneDeleted(filesJson, projectRoot);
    fs.writeFileSync(filesJsonPath, JSON.stringify(filesJson, null, 2), 'utf-8');
    process.exit(0);
  }

  // Analyze new metadata
  const { hash, lines, length, directives, exports, hooks, deps, props, type } = analyzeFile(content, relPath, aliasPrefixes, projectRoot);

  const existing = filesJson[relPath];

  // If hash is identical, no changes → exit
  if (existing && existing.hash === hash) process.exit(0);

  const now = new Date().toISOString();

  if (existing) {
    // Update existing entry — keep baseline, update current
    filesJson[relPath] = {
      ...existing,
      updatedAt: now,
      hash,
      length: { baseline: existing.length.baseline, current: length },
      lines:  { baseline: existing.lines.baseline,  current: lines  },
      directives,
      exports,
      hooks,
      deps,
      props,
      type,
      importedBy: computeImportedBy(relPath, filesJson, aliasPrefixes, projectRoot),
    };
  } else {
    // New file — baseline = current
    const hasSrc = fs.existsSync(path.join(projectRoot, 'src'));
    filesJson[relPath] = {
      group: groupKey(relPath, hasSrc),
      createdAt: now,
      updatedAt: now,
      hash,
      length: { baseline: length, current: length },
      lines:  { baseline: lines,  current: lines  },
      directives,
      exports,
      hooks,
      deps,
      props,
      type,
      importedBy: computeImportedBy(relPath, filesJson, aliasPrefixes, projectRoot),
    };
  }

  // ── Reverse importedBy update ─────────────────────────────────
  // 1) Find internal modules this file currently imports (including new imports)
  const currentlyImports = new Set();
  const fromPattern = /from\s+['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(fromPattern)) {
    const resolved = resolveSpec(m[1], relPath, aliasPrefixes);
    if (!resolved) continue;
    const candidates = path.extname(resolved)
      ? [resolved]
      : [resolved + '.ts', resolved + '.tsx', resolved + '.js', resolved + '.jsx',
         resolved + '/index.ts', resolved + '/index.tsx', resolved + '/index.js', resolved + '/index.jsx'];
    for (const c of candidates) {
      if (filesJson[c]) { currentlyImports.add(c); break; }
    }
  }

  // 2) Find files that previously had this file as an importer (detect removed imports)
  const previouslyImported = new Set();
  for (const otherPath of Object.keys(filesJson)) {
    if (otherPath === relPath) continue;
    if (filesJson[otherPath].importedBy?.some(e => e.importer === relPath)) {
      previouslyImported.add(otherPath);
    }
  }

  // 3) Union: recalculate both new and previous imports
  const toRecalc = new Set([...currentlyImports, ...previouslyImported]);
  for (const targetPath of toRecalc) {
    if (!filesJson[targetPath]) continue;
    filesJson[targetPath].importedBy = computeImportedBy(targetPath, filesJson, aliasPrefixes, projectRoot);
  }

  // Clean up deleted files (Bash rm, or files that disappeared during Write)
  pruneDeleted(filesJson, projectRoot);

  fs.writeFileSync(filesJsonPath, JSON.stringify(filesJson, null, 2), 'utf-8');
}

main().catch(() => process.exit(0));
