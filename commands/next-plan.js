#!/usr/bin/env node
// ─── next-plan.js ────────────────────────────────────────────────
// 1) Sync files.json (reflect missing/changed files)
// 2) Generate .claude/plan.md (per-group code map)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  analyzeFile,
  computeImportedBy,
  loadAliasPrefixes,
  SOURCE_EXTS,
  pruneDeleted,
  discoverNewFiles,
  gitignored,
  tree,
} = require('./utils');

const projectRoot = fs.realpathSync(process.cwd());
const claudeDir = path.join(projectRoot, '.claude');
const filesJsonPath = path.join(claudeDir, 'files.json');
const planPath = path.join(claudeDir, 'plan.md');


// ─── Step 1: Sync files.json ─────────────────────────────────────
function syncFilesJson(filesJson, aliasPrefixes) {
  // Remove deleted file entries
  const deleted = pruneDeleted(filesJson, projectRoot);

  // Add new files
  discoverNewFiles(filesJson, aliasPrefixes, projectRoot);

  // Re-analyze existing files whose hash has changed (user edits missed by hook)
  const changed = new Set(deleted);
  for (const [relPath, entry] of Object.entries(filesJson)) {
    const fullPath = path.join(projectRoot, relPath);
    let content;
    try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
    const analysis = analyzeFile(content, relPath, aliasPrefixes, projectRoot);
    if (analysis.hash === entry.hash) continue;
    filesJson[relPath] = {
      ...entry,
      ...analysis,
      updatedAt: new Date().toISOString(),
      length: { baseline: entry.length.baseline, current: analysis.length },
      lines:  { baseline: entry.lines.baseline,  current: analysis.lines  },
    };
    changed.add(relPath);
  }

  // Recalculate importedBy for changed files
  if (changed.size > 0) {
    for (const relPath of Object.keys(filesJson)) {
      if (!SOURCE_EXTS.has(path.extname(relPath))) continue;
      filesJson[relPath].importedBy = computeImportedBy(relPath, filesJson, aliasPrefixes, projectRoot);
    }
  }

  return changed.size;
}

// ─── Collect Git status + update git-log.md ──────────────────────
function refreshGit() {
  try {
    const isGit = execSync('git rev-parse --is-inside-work-tree 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (isGit !== 'true') return null;
  } catch {
    return null;
  }

  const run = (cmd) => {
    try { return execSync(cmd, { encoding: 'utf-8' }).trim(); } catch { return ''; }
  };

  const branch    = run('git branch --show-current');
  const log       = run('git log --oneline -50');
  const unstaged  = run('git diff --stat HEAD 2>/dev/null');
  const staged    = run('git diff --stat --cached 2>/dev/null');
  const statusRaw = run('git status --short -u');
  const lines     = statusRaw ? statusRaw.split('\n') : [];
  const tracked   = lines.filter(l => !/^\?\?/.test(l)).join('\n');
  const untracked = lines.filter(l =>  /^\?\?/.test(l)).join('\n');

  // Save git-log.md
  const date = new Date().toISOString().split('T')[0];
  const sections = [
    `# Git Log`,
    `> Updated: ${date} · Branch: ${branch || '(unknown)'}`,
    ``,
  ];
  if (tracked)   sections.push(`## Changed Files (tracked)`,  '```', tracked,   '```', '');
  if (untracked) sections.push(`## New Files (untracked)`,    '```', untracked, '```', '');
  if (unstaged) {
    sections.push(`## Change Stats`, '```', unstaged, '```', '');
  } else if (staged) {
    sections.push(`## Change Stats (staged)`, '```', staged, '```', '');
  }
  sections.push(`## Recent Commits (up to 50)`, log || '(no commits)');
  fs.writeFileSync(path.join(claudeDir, 'git-log.md'), sections.join('\n'), 'utf-8');

  return { branch, unstaged, staged };
}

// ─── Generate group detail section ───────────────────────────────
const ENTRY_NAMES = /^(page|layout|route|loading|error|not-found|template|default|middleware)\.(tsx?|jsx?)$/;

function generateGroupContent(group, files, filesJson, today) {
  const lines = [];
  lines.push(`# ${group} (${files.length} files)`);
  lines.push(`> Updated: ${today}`);
  lines.push('');

  for (const [relPath, entry] of files) {
    const filename = path.basename(relPath);
    const dirPart = path.dirname(relPath) !== '.' ? `*${path.dirname(relPath)}/*` : '';

    // Unused file detection: no importedBy and not an entry point
    const isEntry = ENTRY_NAMES.test(filename);
    const isUnused = !entry.importedBy?.length && !isEntry;

    const titleParts = [`**${filename}**`];
    if (dirPart) titleParts.push(dirPart);
    if (entry.directives?.length) titleParts.push(`\`${entry.directives.join(', ')}\``);
    if (isUnused) titleParts.push('`⚠️unused`');
    titleParts.push(`· ${entry.lines?.current ?? entry.lines?.baseline ?? 0} lines`);
    lines.push(titleParts.join(' '));

    if (entry.type) {
      lines.push(`  type: ${entry.type}`);
    }
    if (entry.exports?.length) {
      // Unused export detection: not in any importer's named list
      const usedNames = new Set((entry.importedBy ?? []).flatMap(e => e.named ?? []));
      const formatted = entry.exports.map(e =>
        usedNames.has(e) ? `\`${e}\`` : `\`${e}\`⚠️`
      );
      lines.push(`  exports: ${formatted.join(', ')}`);
    }
    if (entry.props?.length) {
      lines.push(`  props: ${entry.props.map(p => `\`${p}\``).join(', ')}`);
    }
    if (entry.hooks?.length) {
      lines.push(`  hooks: ${entry.hooks.map(h => `\`${h}\``).join(', ')}`);
    }

    const internalDeps = [];
    for (const [otherPath, otherEntry] of Object.entries(filesJson)) {
      if (otherPath === relPath) continue;
      if (otherEntry.importedBy?.some(e => e.importer === relPath)) {
        internalDeps.push(path.basename(otherPath));
      }
    }
    if (internalDeps.length) {
      lines.push(`  imports: ${internalDeps.map(d => `\`${d}\``).join(', ')}`);
    }

    if (entry.importedBy?.length) {
      const importers = entry.importedBy.map(e => {
        const file = `\`${path.basename(e.importer)}\``;
        return e.named?.length ? `${file}(${e.named.join(', ')})` : file;
      });
      const shown = importers.slice(0, 4).join(', ');
      const extra = importers.length > 4 ? ` (+${importers.length - 4})` : '';
      lines.push(`  imported by: ${shown}${extra}`);
    } else {
      lines.push(`  imported by: none`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Step 2: Generate plan.md + group/*.md ───────────────────────
function generatePlan(filesJson, git, groupDir) {
  const today = new Date().toISOString().slice(0, 10);
  const total = Object.keys(filesJson).length;

  // Group by category (source files only)
  const groups = new Map();
  for (const [relPath, entry] of Object.entries(filesJson)) {
    if (!SOURCE_EXTS.has(path.extname(relPath))) continue;
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push([relPath, entry]);
  }

  // Sort files within each group by importedBy count (descending)
  for (const files of groups.values()) {
    files.sort((a, b) => (b[1].importedBy?.length ?? 0) - (a[1].importedBy?.length ?? 0));
  }

  // Sort groups by file count (descending)
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  // Generate group/*.md files
  fs.mkdirSync(groupDir, { recursive: true });
  // Remove stale group files not in current groups
  const currentGroupFiles = new Set(sortedGroups.map(([g]) => `${g}.md`));
  for (const f of fs.readdirSync(groupDir)) {
    if (!currentGroupFiles.has(f)) fs.unlinkSync(path.join(groupDir, f));
  }
  for (const [group, files] of sortedGroups) {
    const content = generateGroupContent(group, files, filesJson, today);
    fs.writeFileSync(path.join(groupDir, `${group}.md`), content, 'utf-8');
  }

  // plan.md = index + Git status + cross-group dependencies
  const lines = [];
  lines.push(`# Code Map`);
  lines.push(`> Updated: ${today} · ${total} files total`);
  lines.push('');

  // Git status section
  if (git) {
    lines.push(`## Git Status`);
    lines.push(`> Branch: ${git.branch || '(unknown)'}`);
    lines.push('');
    if (git.unstaged) {
      lines.push('### Changed Files (unstaged/staged)');
      lines.push('```');
      lines.push(git.unstaged);
      lines.push('```');
      lines.push('');
    }
    if (git.staged && git.staged !== git.unstaged) {
      lines.push('### Staged Files');
      lines.push('```');
      lines.push(git.staged);
      lines.push('```');
      lines.push('');
    }
    if (!git.unstaged && !git.staged) {
      lines.push('> No changed files');
      lines.push('');
    }
  }

  // Group list
  lines.push('## Groups');
  lines.push('');
  for (const [group, files] of sortedGroups) {
    lines.push(`- **${group}** (${files.length} files) → \`.claude/group/${group}.md\``);
  }
  lines.push('');

  // Cross-group dependency summary
  const crossDeps = new Map();
  for (const [relPath, entry] of Object.entries(filesJson)) {
    const fromGroup = entry.group;
    for (const [otherPath, otherEntry] of Object.entries(filesJson)) {
      if (otherPath === relPath) continue;
      const toGroup = otherEntry.group;
      if (fromGroup === toGroup) continue;
      if (otherEntry.importedBy?.some(e => e.importer === relPath)) {
        const key = `${fromGroup} → ${toGroup}`;
        if (!crossDeps.has(key)) crossDeps.set(key, []);
        crossDeps.get(key).push(`${path.basename(relPath)}→${path.basename(otherPath)}`);
      }
    }
  }

  if (crossDeps.size > 0) {
    lines.push('## Cross-Group Dependencies');
    lines.push('');
    for (const [key, deps] of [...crossDeps.entries()].sort()) {
      const shown = deps.slice(0, 5).join(', ');
      const extra = deps.length > 5 ? ` (+${deps.length - 5})` : '';
      lines.push(`- **${key}**: ${shown}${extra}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── main ────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(filesJsonPath)) {
    console.error('❌ files.json not found — run next-init first');
    process.exit(1);
  }

  let filesJson;
  try {
    filesJson = JSON.parse(fs.readFileSync(filesJsonPath, 'utf-8'));
  } catch {
    console.error('❌ Failed to parse files.json');
    process.exit(1);
  }

  const aliasPrefixes = loadAliasPrefixes(projectRoot);

  // Step 1: Sync
  const changedCount = syncFilesJson(filesJson, aliasPrefixes);
  fs.writeFileSync(filesJsonPath, JSON.stringify(filesJson, null, 2), 'utf-8');
  if (changedCount > 0) {
    console.log(`🔄 files.json updated (${changedCount} changes)`);
  } else {
    console.log('✅ files.json is up to date');
  }

  // Step 2: Collect git + update git-log.md
  const git = refreshGit();
  if (git) console.log('🔄 .claude/git-log.md updated');

  // Step 3: Update tree.txt
  const ignored = gitignored(projectRoot);
  fs.writeFileSync(path.join(claudeDir, 'tree.txt'), tree(projectRoot, ignored), 'utf-8');
  console.log('🔄 .claude/tree.txt updated');

  // Step 4: Generate plan.md + group/*.md
  const groupDir = path.join(claudeDir, 'group');
  const plan = generatePlan(filesJson, git, groupDir);
  fs.writeFileSync(planPath, plan, 'utf-8');
  console.log(`✅ plan.md + group/*.md generated (${Object.keys(filesJson).length} files)`);
}

main();
