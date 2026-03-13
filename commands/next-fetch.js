#!/usr/bin/env node

/**
 * next-fetch — Next.js 문서 다운로드
 *
 * 사용법:
 *   node next-fetch.js <url-or-path> [url-or-path ...]
 *
 * 예시:
 *   node next-fetch.js https://nextjs.org/docs/app/getting-started
 *   node next-fetch.js /docs/app/getting-started/installation
 *
 * 저장 규칙:
 *   /docs/app/getting-started           → docs/app/getting-started/index.md
 *   /docs/app/getting-started/installation → docs/app/getting-started/installation.md
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DOCS_BASE = 'https://nextjs.org';
const skillDir = path.resolve(__dirname, '..');
const docsDir = path.join(skillDir, 'docs');

// ─── URL 정규화 ──────────────────────────────────────────────────
function normalize(input) {
  if (input.startsWith('http')) return input;
  return DOCS_BASE + (input.startsWith('/') ? input : '/' + input);
}

// ─── URL → 저장 경로 변환 ────────────────────────────────────────
function savePath(url) {
  // /docs/app/getting-started → docs/app/getting-started/index.md
  // /docs/app/getting-started/installation → docs/app/getting-started/installation.md
  const parsed = new URL(url);
  let segments = parsed.pathname.replace(/^\/docs\//, '').split('/').filter(Boolean);

  // 버전 prefix 제거 (13, 14, 15)
  if (/^\d+$/.test(segments[0])) segments = segments.slice(1);

  if (!segments.length) return path.join(docsDir, 'index.md');
  const last = segments[segments.length - 1];

  // app/ 또는 pages/ 바로 다음 세그먼트가 마지막이면 섹션 루트 → index.md
  // 예: app/getting-started (2개)          → getting-started/index.md
  // 예: app/getting-started/installation (3개) → getting-started/installation.md
  // 예: pages/getting-started/installation (3개) → pages/getting-started/installation.md
  const firstSeg = segments[0];
  const isRouterRoot = firstSeg === 'app' || firstSeg === 'pages';
  const isSection = !last.includes('.') && isRouterRoot && segments.length <= 2;

  if (isSection) {
    return path.join(docsDir, ...segments, 'index.md');
  }

  const dir = segments.slice(0, -1);
  const file = last.endsWith('.md') ? last : last + '.md';
  return path.join(docsDir, ...dir, file);
}

// ─── HTML redirect 추적 → 최종 URL 반환 ────────────────────────
function resolve(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error(`Too many redirects: ${url}`));
  return new Promise((resolveP, reject) => {
    https.get(url, res => {
      res.resume();
      const code = res.statusCode;
      if (code && [301, 302, 307, 308].includes(code) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://nextjs.org' + res.headers.location;
        // nextjs.org/docs/ 외부로 나가는 리다이렉트는 무시
        if (!next.startsWith('https://nextjs.org/docs/')) { resolveP(url); return; }
        return resolve(next, redirectCount + 1).then(resolveP).catch(reject);
      }
      resolveP(url);
    }).on('error', reject);
  });
}

// ─── .md URL fetch ───────────────────────────────────────────────
function get(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error(`Too many redirects: ${url}`));
  return new Promise((resolveP, reject) => {
    https.get(url, res => {
      const code = res.statusCode;
      if (code && [301, 302, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : 'https://nextjs.org' + res.headers.location;
        return get(next, redirectCount + 1).then(resolveP).catch(reject);
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code}: ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolveP(data));
    }).on('error', reject);
  });
}

// ─── fetch with redirect + fallback ──────────────────────────────
// 1) HTML redirect 추적해서 최종 URL 확보
// 2) 최종 URL + .md 로 fetch
// 3) 실패 시 버전 prefix 제거 후 재시도
async function getWithFallback(url) {
  // strip .md if present before resolving redirects
  const baseUrl = url.endsWith('.md') ? url.slice(0, -3) : url;

  // HTML redirect 추적
  const finalUrl = await resolve(baseUrl).catch(() => baseUrl);
  const mdUrl = finalUrl + '.md';

  try {
    return await get(mdUrl);
  } catch {
    // 버전 prefix 제거 후 재시도 (/docs/15/app/... → /docs/app/...)
    const fallback = mdUrl.replace(/\/docs\/\d+\//, '/docs/');
    if (fallback === mdUrl) throw new Error(`404: ${url}`);
    return await get(fallback);
  }
}

// ─── 문서 1개 다운로드 ───────────────────────────────────────────
async function download(input) {
  const url = normalize(input);
  const baseUrl = url.endsWith('.md') ? url.slice(0, -3) : url;
  // redirect 추적해서 최종 URL로 저장 경로 결정
  const finalUrl = await resolve(baseUrl).catch(() => baseUrl);
  const dest = savePath(finalUrl);

  const content = await getWithFallback(url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf-8');

  const rel = path.relative(skillDir, dest);
  console.log(`✅ ${rel}`);
  return { url, dest };
}

// ─── 문서 내 링크 재귀 다운로드 ─────────────────────────────────
async function downloadWithLinks(input, depth = 1) {
  const url = normalize(input);
  if (!url.startsWith('https://nextjs.org/docs/')) {
    console.warn(`⚠️  skip (out-of-scope): ${url}`);
    return;
  }
  const dest = savePath(url);

  // 이미 존재하면 스킵
  if (fs.existsSync(dest)) {
    console.log(`⏭  ${path.relative(skillDir, dest)} (already exists)`);
    return;
  }

  let content;
  try {
    content = await getWithFallback(url);
  } catch (e) {
    console.warn(`⚠️  skip: ${url} (${e.message})`);
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf-8');
  console.log(`✅ ${path.relative(skillDir, dest)}`);

  if (depth <= 0) return;

  // 문서 내 /docs/... 링크 추출해서 재귀 다운로드
  const linkPattern = /\]\(\/docs\/([^)]+)\)/g;
  const subLinks = [...content.matchAll(linkPattern)]
    .map(m => '/docs/' + m[1].split('#')[0])
    .filter(l => !l.endsWith('.md') || l.endsWith('/'))
    .filter((v, i, a) => a.indexOf(v) === i); // dedupe

  await Promise.allSettled(subLinks.map(l => downloadWithLinks(l, depth - 1)));
}

// ─── 메인 ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const recursive = args.includes('--recursive') || args.includes('-r');
  const targets = args.filter(a => !a.startsWith('-'));

  if (targets.length === 0) {
    console.error('사용법: node next-fetch.js <url-or-path> [--recursive]');
    console.error('예시: node next-fetch.js /docs/app/getting-started --recursive');
    process.exit(1);
  }

  if (recursive) {
    await Promise.allSettled(targets.map(t => downloadWithLinks(t, 1)));
  } else {
    const results = await Promise.allSettled(targets.map(download));
    for (const r of results) {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`⚠️  skip: ${msg}`);
      }
    }
  }
}

main();
