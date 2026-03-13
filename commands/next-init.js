#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { analyzeFile, computeImportedBy, buildAliasPrefixes, groupKey, SOURCE_EXTS, gitignored, tree } = require('./utils');

const projectRoot = process.cwd();

// ─── Detect package manager ─────────────────────────────────────
function manager() {
  // Detect by lockfile (most reliable)
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectRoot, 'package-lock.json'))) return 'npm';

  // package.json "packageManager" field (corepack standard)
  try {
    const p = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'));
    if (p.packageManager) return p.packageManager.split('@')[0];
  } catch {}

  return 'unknown';
}

// ─── Parse package.json ─────────────────────────────────────────
function pkg() {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
}

function version(p, name) {
  const all = { ...p.dependencies, ...p.devDependencies };
  const raw = all[name];
  if (!raw) return null;
  return raw.replace(/^[\^~]/, '');
}

function has(p, name) {
  const all = { ...p.dependencies, ...p.devDependencies };
  return name in all;
}

// ─── Detect src/ directory + routing type ───────────────────────
function router() {
  const hasSrc = fs.existsSync(path.join(projectRoot, 'src'));
  const hasApp = fs.existsSync(path.join(projectRoot, 'src', 'app')) ||
                 fs.existsSync(path.join(projectRoot, 'app'));
  const hasPages = fs.existsSync(path.join(projectRoot, 'src', 'pages')) ||
                   fs.existsSync(path.join(projectRoot, 'pages'));

  let type;
  if (hasApp && hasPages) type = 'Mixed (App + Pages)';
  else if (hasApp) type = 'App Router';
  else if (hasPages) type = 'Pages Router';
  else type = 'unknown';

  return { type, src: hasSrc };
}

// ─── Detect tsconfig paths alias ────────────────────────────────
function aliases() {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;
  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    const paths = tsconfig?.compilerOptions?.paths;
    if (!paths) return null;
    return Object.entries(paths).map(([alias, targets]) => ({
      alias,
      target: targets[0].replace('/*', ''),
    }));
  } catch {
    return null;
  }
}

// ─── Extract .env key list ──────────────────────────────────────
function envKeys() {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production'];
  const keys = new Set();
  for (const file of envFiles) {
    const envPath = path.join(projectRoot, file);
    if (!fs.existsSync(envPath)) continue;
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const key = trimmed.split('=')[0].trim();
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

// ─── Detect next.config experimental flags ──────────────────────
function nextConfig() {
  const candidates = ['next.config.ts', 'next.config.js', 'next.config.mjs'];
  for (const file of candidates) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const flags = [];
    const experimentalMatch = content.match(/experimental\s*:\s*\{([^}]+)\}/s);
    if (experimentalMatch) {
      const block = experimentalMatch[1];
      const keys = [...block.matchAll(/(\w+)\s*:/g)].map(m => m[1]);
      flags.push(...keys);
    }
    return { file, experimental: flags };
  }
  return null;
}

// ─── Detect major libraries ─────────────────────────────────────
function libs(p) {
  const checks = {
    'State Management': ['zustand', 'jotai', 'redux', '@reduxjs/toolkit', 'recoil', 'valtio'],
    'Data Fetching': ['@tanstack/react-query', 'react-query', 'swr', 'axios'],
    'Auth': ['next-auth', '@clerk/nextjs', 'better-auth'],
    'UI': ['@shadcn/ui', '@radix-ui/react-primitives', '@chakra-ui/react', '@mantine/core', 'framer-motion'],
  };

  const result = {};
  for (const [category, packages] of Object.entries(checks)) {
    const found = packages.filter(name => has(p, name));
    if (found.length > 0) result[category] = found;
  }
  return result;
}

// ─── .gitignore parsing ─────────────────────────────────────────
// gitignored, tree → shared functions from utils.js

// ─── Generate file path list ────────────────────────────────────
function filePaths(dir, ignored, base = '') {
  const ALWAYS_IGNORE = ['node_modules', '.next', '.git', '.claude'];
  let entries;
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }

  const filtered = entries.filter(name => {
    if (ALWAYS_IGNORE.includes(name)) return false;
    return !ignored.some(pattern => {
      const clean = pattern.replace(/\/$/, '');
      return name === clean || name.startsWith(clean + '/');
    });
  });

  const result = [];
  for (const name of filtered) {
    const fullPath = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(fullPath).isDirectory()) {
      result.push(...filePaths(fullPath, ignored, rel));
    } else {
      result.push(rel);
    }
  }
  return result;
}



// ─── llms.txt fetch ─────────────────────────────────────────────
function fetch(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error(`Too many redirects: ${url}`));
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://nextjs.org' + res.headers.location;
        return fetch(next, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function docs(nextVer) {
  const major = (nextVer && nextVer !== 'unknown')
    ? parseInt(nextVer.split('.')[0], 10)
    : 15;
  const filename = `next${major}.md`;

  // llms.txt = URL list only (lightweight). Use /next-fetch for full content
  const urls = [
    `https://nextjs.org/docs/${major}/llms.txt`,
    'https://nextjs.org/docs/llms.txt',
  ];

  for (const url of urls) {
    try {
      const raw = await fetch(url);
      // Parse llms.txt: "- [Title](URL): Description" format → hierarchical markdown
      const content = parseLlmsTxt(raw, major);
      return { major, filename, content };
    } catch {}
  }
  return { major, filename, content: null };
}

function parseLlmsTxt(raw, major) {
  const lines = raw.split('\n');
  const out = [`# Next.js ${major} Docs Index`, `> Download individual docs with /next-fetch <URL>`, ``];
  for (const line of lines) {
    const m = line.match(/^(-\s*\[.+?\]\(.+?\).*)/);
    if (m) out.push(m[1]);
  }
  return out.join('\n');
}

// ─── Generate index.md ──────────────────────────────────────────
function render(data) {
  const { packageManager, versions, route, libraries, aliasMap, env, config, docsList, git } = data;
  const date = new Date().toISOString().split('T')[0];

  const tsLine = versions.typescript
    ? `- TypeScript: ✅ ${versions.typescript}`
    : `- TypeScript: ❌`;

  const tailwindLine = versions.tailwindcss
    ? `- Tailwind CSS: ✅ ${versions.tailwindcss}`
    : `- Tailwind CSS: ❌`;

  const libraryLines = Object.entries(libraries)
    .map(([cat, pkgs]) => `- ${cat}: ${pkgs.join(', ')}`)
    .join('\n');

  const aliasLines = aliasMap
    ? aliasMap.map(({ alias, target }) => `- \`${alias}\` → \`${target}\``).join('\n')
    : '- none';

  const envLines = env.length > 0
    ? env.map(k => `- ${k}`).join('\n')
    : '- none';

  const configLines = config
    ? [
        `- Config file: ${config.file}`,
        config.experimental.length > 0
          ? `- experimental: ${config.experimental.join(', ')}`
          : `- experimental: none`,
      ].join('\n')
    : '- next.config not found';

  const docsSection = docsList.content
    ? `## Next.js Docs\n> Latest reference: \`.claude/${docsList.filename}\``
    : '';

  const gitSection = git
    ? `## Git\n> Branch: ${git.branch} · See \`.claude/git-log.md\``
    : '';

  return `# Project Index
> Generated by reNext init — ${date}

## Package Manager
- ${packageManager}

## Next.js Info
- Next.js: ${versions.next || 'unknown'}
- React: ${versions.react || 'unknown'}
${tsLine}
- Routing: ${route.type}
- src/ structure: ${route.src ? '✅' : '❌'}

## Styling
${tailwindLine}

## Path Alias
${aliasLines}

## Environment Variables
${envLines}

## Next.js Config
${configLines}

## Major Libraries
${libraryLines || '- No libraries detected'}

## File Structure
> See \`.claude/tree.txt\` (updated on \`/next-plan\`)

${docsSection}

${gitSection}
`;
}

// ─── Collect Git history ────────────────────────────────────────
function gitLog() {
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
  const statusRaw = run('git status --short -u');             // -u: show individual files in directories
  const lines     = statusRaw ? statusRaw.split('\n') : [];
  const tracked   = lines.filter(l => !/^\?\?/.test(l)).join('\n');
  const untracked = lines.filter(l =>  /^\?\?/.test(l)).join('\n');

  return { branch, log, unstaged, staged, tracked, untracked };
}

// ─── Main execution ─────────────────────────────────────────────
async function main() {
  const p = pkg();
  if (!p) {
    console.error('❌ Cannot find package.json. Please run from the project root.');
    process.exit(1);
  }

  const nextVer = version(p, 'next');
  const ignored = gitignored(projectRoot);

  process.stdout.write('⏳ Analyzing project...\n');
  const docsList = await docs(nextVer);

  const data = {
    packageManager: manager(),
    versions: {
      next: nextVer,
      react: version(p, 'react'),
      typescript: version(p, 'typescript'),
      tailwindcss: version(p, 'tailwindcss'),
    },
    route: router(),
    libraries: libs(p),
    aliasMap: aliases(),
    env: envKeys(),
    config: nextConfig(),
    docsList,
    git: gitLog(),
  };

  const md = render(data);

  const claudeDir = path.join(projectRoot, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'index.md'), md, 'utf-8');
  console.log('✅ .claude/index.md created');

  // Save full Next.js docs index
  if (docsList.content) {
    fs.writeFileSync(path.join(claudeDir, docsList.filename), docsList.content, 'utf-8');
    console.log(`✅ .claude/${docsList.filename} created`);
  }

  const allFiles = filePaths(projectRoot, ignored);
  const hasSrc = fs.existsSync(path.join(projectRoot, 'src'));
  const aliasMapData = aliases();
  const aliasPrefixes = buildAliasPrefixes(aliasMapData);
  const now = new Date().toISOString();

  // Build files.json (phase 1: analyze each file)
  const filesJson = {};
  for (const relPath of allFiles) {
    const fullPath = path.join(projectRoot, relPath);
    let content = '';
    try { content = fs.readFileSync(fullPath, 'utf-8'); } catch {}
    const { hash, lines, length, directives, exports, hooks, deps, props, type } = analyzeFile(content, relPath, aliasPrefixes, projectRoot);
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
      importedBy: [],
    };
  }

  // Build files.json (phase 2: compute importedBy)
  for (const relPath of allFiles) {
    if (!SOURCE_EXTS.has(path.extname(relPath))) continue;
    filesJson[relPath].importedBy = computeImportedBy(relPath, filesJson, aliasPrefixes, projectRoot);
  }

  fs.writeFileSync(path.join(claudeDir, 'files.json'), JSON.stringify(filesJson, null, 2), 'utf-8');
  console.log(`✅ .claude/files.json created (${allFiles.length} files)`);

  // Save tree.txt
  const treeStr = tree(projectRoot, ignored);
  fs.writeFileSync(path.join(claudeDir, 'tree.txt'), treeStr, 'utf-8');
  console.log('✅ .claude/tree.txt created');

  // Clean up legacy files
  for (const old of ['files.md', 'imports.md']) {
    const p = path.join(claudeDir, old);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // Inject Hook settings (.claude/settings.json)
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) : {};
  settings.hooks = {
    PostToolUse: [{
      matcher: 'Write|Edit|Bash',
      hooks: [{ type: 'command', command: 'node .claude/skills/renext/commands/next-update.js 2>/dev/null' }],
    }],
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  console.log('✅ .claude/settings.json hook configured');

  // Register slash commands (.claude/commands/)
  const commandsDir = path.join(claudeDir, 'commands');
  if (!fs.existsSync(commandsDir)) fs.mkdirSync(commandsDir, { recursive: true });
  const slashCommands = [
    {
      file: 'next-init.md',
      script: 'next-init.js',
      note: 'After execution, read `.claude/index.md` with the Read tool and show the results to the user.',
    },
    {
      file: 'next-fetch.md',
      script: 'next-fetch.js',
      note: 'After download, read the file with the Read tool and use it to answer.\n\nUsage: /next-fetch <url-or-path> [--recursive]',
    },
    {
      file: 'next-plan.md',
      script: 'next-plan.js',
      note: 'After execution, read `.claude/plan.md` with the Read tool and summarize the code structure for the user.',
    },
    {
      file: 'next-implement.md',
      script: null,
      note: '/reNext next-implement $ARGUMENTS',
    },
  ];
  for (const { file, script, note } of slashCommands) {
    const lines = script
      ? [`node .claude/skills/renext/commands/${script}`, '', note]
      : [note];
    fs.writeFileSync(path.join(commandsDir, file), lines.join('\n'), 'utf-8');
  }
  console.log('✅ .claude/commands/ slash commands registered (next-init, next-fetch, next-plan, next-implement)');

  // Generate CLAUDE.md — skill template + inject actual file tree
  const skillDir = path.resolve(__dirname, '..');
  const templatePath = path.join(skillDir, 'CLAUDE.md');
  if (fs.existsSync(templatePath)) {
    let claudeMd = fs.readFileSync(templatePath, 'utf-8');

    // Replace recommended structure code block with actual project tree
    claudeMd = claudeMd.replace(
      /Recommended structure:\n```[\s\S]*?```/,
      `Actual project structure:\n\`\`\`\n${treeStr}\n\`\`\``
    );

    if (docsList.content) {
      claudeMd += `\n\n## Next.js Docs\n> Latest Next.js ${docsList.major} reference: \`.claude/${docsList.filename}\`\n`;
    }

    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), claudeMd, 'utf-8');
    console.log('✅ .claude/CLAUDE.md created');
  }

  // git-log.md — collect after all files are created (prevent omissions)
  const freshGit = gitLog();
  if (freshGit) {
    const { branch, log, unstaged, staged, tracked, untracked } = freshGit;
    const date = new Date().toISOString().split('T')[0];
    const sections = [
      `# Git Log`,
      `> Created: ${date} · Branch: ${branch || '(unknown)'}`,
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
    console.log('✅ .claude/git-log.md created');
  }
}

main();
