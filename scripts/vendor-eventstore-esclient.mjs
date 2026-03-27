#!/usr/bin/env node
/**
 * 从网络或本地拉取 eventstoreUI 的 esclient.ts，并打包为 esclient.cjs。
 *
 * 用法：
 *   npm run vendor:esclient
 *
 * 网络不稳时可选：
 *   ESCLIENT_LOCAL=/path/to/eventstoreUI/src/lib/esclient.ts npm run vendor:esclient
 *   ESCLIENT_SOURCE_URL=https://你的镜像/raw/... npm run vendor:esclient
 */
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const vendor = path.join(root, 'lib', 'eventstore-vendor');
const src = path.join(vendor, 'esclient.ts');

const DEFAULT_URLS = [
  process.env.ESCLIENT_SOURCE_URL,
  'https://raw.githubusercontent.com/asmcos/eventstoreUI/main/src/lib/esclient.ts',
  // 部分网络访问 raw.githubusercontent.com 超时，可尝试前置代理（不保证长期可用，可自行换镜像）
  'https://ghfast.top/https://raw.githubusercontent.com/asmcos/eventstoreUI/main/src/lib/esclient.ts',
  'https://mirror.ghproxy.com/https://raw.githubusercontent.com/asmcos/eventstoreUI/main/src/lib/esclient.ts',
].filter(Boolean);

const FETCH_TIMEOUT_MS = Number(process.env.ESCLIENT_FETCH_TIMEOUT_MS) || 120000;
const RETRIES = Math.max(1, Number(process.env.ESCLIENT_FETCH_RETRIES) || 3);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasCurl() {
  try {
    execFileSync('curl', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** 用 curl：连接/总超时与重试，适合 raw.githubusercontent.com 偶发超时 */
function downloadViaCurl(url) {
  const out = execFileSync(
    'curl',
    [
      '-fsSL',
      '--connect-timeout',
      '45',
      '--max-time',
      String(Math.floor(FETCH_TIMEOUT_MS / 1000)),
      '--retry',
      '2',
      '--retry-delay',
      '3',
      url,
    ],
    { encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 },
  );
  return out;
}

async function downloadViaFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'MarkWrite-vendor-esclient/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function downloadText(url) {
  if (hasCurl()) {
    try {
      return downloadViaCurl(url);
    } catch (e) {
      console.warn(`curl 失败 (${url.slice(0, 60)}…):`, e && e.message ? e.message : e);
    }
  }
  return downloadViaFetch(url);
}

async function downloadWithRetries(urls) {
  const errors = [];
  for (const url of urls) {
    for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
      try {
        console.log(`尝试拉取 (${attempt}/${RETRIES}): ${url}`);
        const text = await downloadText(url);
        if (text && text.length > 100) return { text, url };
      } catch (e) {
        const msg = e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : String(e));
        errors.push(`${url} → ${msg}`);
        console.warn(`  失败: ${msg}`);
        if (attempt < RETRIES) await sleep(2000 * attempt);
      }
    }
  }
  throw new Error(`所有 URL 均失败:\n${errors.join('\n')}`);
}

function readLocalFile(p) {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  if (!fs.existsSync(abs)) return null;
  console.log('使用本地文件:', abs);
  return fs.readFileSync(abs, 'utf8');
}

let text;
const local = process.env.ESCLIENT_LOCAL;
if (local) {
  text = readLocalFile(local);
  if (!text) {
    console.error('ESCLIENT_LOCAL 指向的文件不存在:', local);
    process.exit(1);
  }
} else {
  const sibling = path.join(root, '..', 'eventstoreUI', 'src', 'lib', 'esclient.ts');
  text = readLocalFile(sibling);
}

if (!text) {
  try {
    const { text: downloaded, url: usedUrl } = await downloadWithRetries(DEFAULT_URLS);
    text = downloaded;
    console.log('已下载:', usedUrl);
  } catch (e) {
    console.error(e.message || e);
    console.error(`
仍失败时可任选其一：
  1) 克隆仓库后指定本地路径：
     ESCLIENT_LOCAL=/path/to/eventstoreUI/src/lib/esclient.ts npm run vendor:esclient
  2) 把 esclient.ts 放到 MarkWrite 旁 ../eventstoreUI/src/lib/esclient.ts（脚本会自动找）
  3) 自行设置镜像 URL：
     ESCLIENT_SOURCE_URL=https://… npm run vendor:esclient
  4) 调大超时与重试：
     ESCLIENT_FETCH_TIMEOUT_MS=300000 ESCLIENT_FETCH_RETRIES=5 npm run vendor:esclient
`);
    process.exit(1);
  }
}

text = text.replace(
  /import\s*\{\s*esserver\s*\}\s*from\s*["']\.\/config["']/,
  "import { esserver } from './config.cjs'",
);
fs.mkdirSync(vendor, { recursive: true });
fs.writeFileSync(src, text, 'utf8');
console.log('Wrote', src);

execSync(
  `npx esbuild "${src}" --bundle --platform=node --format=cjs --outfile="${path.join(vendor, 'esclient.cjs')}" --external:./config.cjs --packages=external`,
  { stdio: 'inherit', cwd: root },
);
console.log('Built lib/eventstore-vendor/esclient.cjs');
