#!/usr/bin/env node
// ─── next-search.js ─────────────────────────────────────────────
// Query files.json for a file path and output metadata + 1-hop related files

const fs = require('fs');
const path = require('path');

const projectRoot = fs.realpathSync(process.cwd());
const claudeDir = path.join(projectRoot, '.claude');
const filesJsonPath = path.join(claudeDir, 'files.json');

const query = process.argv[2];
if (!query) {
  console.error('Usage: next-search <file-path>');
  process.exit(1);
}

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

// Match: exact path, ends with query, or basename match
const matches = Object.keys(filesJson).filter(p =>
  p === query || p.endsWith('/' + query) || path.basename(p) === query
);

if (!matches.length) {
  console.log('No matches found.');
  process.exit(0);
}

for (const relPath of matches) {
  const entry = filesJson[relPath];

  // File info
  console.log(`## ${relPath} · ${entry.lines?.current ?? 0} lines`);
  if (entry.type) console.log(`  type: ${entry.type}`);
  if (entry.exports?.length) console.log(`  exports: ${entry.exports.map(e => '`' + e + '`').join(', ')}`);
  if (entry.props?.length) console.log(`  props: ${entry.props.map(p => '`' + p + '`').join(', ')}`);
  if (entry.hooks?.length) console.log(`  hooks: ${entry.hooks.map(h => '`' + h + '`').join(', ')}`);
  if (entry.directives?.length) console.log(`  directives: ${entry.directives.join(', ')}`);
  if (entry.deps?.length) console.log(`  deps: ${entry.deps.map(d => '`' + d + '`').join(', ')}`);

  // imported by
  if (entry.importedBy?.length) {
    const importers = entry.importedBy.map(e => {
      const file = path.basename(e.importer);
      return e.named?.length ? `${file}(${e.named.join(', ')})` : file;
    });
    console.log(`  imported by: ${importers.join(', ')}`);
  } else {
    console.log(`  imported by: none`);
  }

  // imports (files this file imports)
  const internalImports = [];
  for (const [otherPath, otherEntry] of Object.entries(filesJson)) {
    if (otherPath === relPath) continue;
    if (otherEntry.importedBy?.some(e => e.importer === relPath)) {
      internalImports.push(otherPath);
    }
  }
  if (internalImports.length) {
    console.log(`  imports: ${internalImports.map(p => path.basename(p)).join(', ')}`);
  }
  console.log('');

  // Related (1-hop) — importers + imported files
  const related = new Set([
    ...internalImports,
    ...(entry.importedBy || []).map(e => e.importer),
  ]);

  if (related.size > 0) {
    console.log('## Related (1-hop)');
    for (const rp of related) {
      const re = filesJson[rp];
      if (!re) continue;
      let header = `  ${rp} · ${re.lines?.current ?? 0} lines`;
      if (re.type) header += ` · ${re.type}`;
      console.log(header);

      // What does this related file use from the target?
      const asImporter = entry.importedBy?.find(e => e.importer === rp);
      if (asImporter?.named?.length) {
        console.log(`    uses: ${asImporter.named.map(n => '`' + n + '`').join(', ')}`);
      }
      if (re.exports?.length) {
        console.log(`    exports: ${re.exports.map(e => '`' + e + '`').join(', ')}`);
      }
    }
    console.log('');
  }
}
