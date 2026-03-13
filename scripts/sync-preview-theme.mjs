#!/usr/bin/env node
/**
 * 从 VitePress 官方仓库拉取默认主题样式到 preview-theme/
 * 来源: https://github.com/vuejs/vitepress/tree/main/src/client/theme-default/styles
 * 运行: npm run sync-preview-theme
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PREVIEW_THEME = path.join(ROOT, 'preview-theme');
const BASE_URL = 'https://raw.githubusercontent.com/vuejs/vitepress/main/src/client/theme-default/styles';

const FILES = [
  'base.css',
  'vars.css',
  'fonts.css',
  'icons.css',
  'utils.css',
  'components/custom-block.css',
  'components/vp-code.css',
  'components/vp-doc.css',
  'components/vp-code-group.css',
  'components/vp-sponsor.css',
];

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.text();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  ensureDir(PREVIEW_THEME);
  ensureDir(path.join(PREVIEW_THEME, 'components'));

  for (const file of FILES) {
    const url = `${BASE_URL}/${file}`;
    const dest = path.join(PREVIEW_THEME, file);
    process.stdout.write(`Fetching ${file} ... `);
    try {
      const text = await fetchText(url);
      fs.writeFileSync(dest, text, 'utf8');
      console.log('ok');
    } catch (e) {
      console.log('FAIL:', e.message);
    }
  }

  console.log('Done. preview-theme/ updated from VitePress default theme.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
