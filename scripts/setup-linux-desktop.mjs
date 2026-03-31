import fs from 'fs';
import os from 'os';
import path from 'path';

if (process.platform !== 'linux') {
  console.log('[linux:desktop] Skip: non-Linux platform.');
  process.exit(0);
}

const ROOT = process.cwd();
const iconPath = path.join(ROOT, 'assets', 'markwrite-icon.png');
const electronPath = path.join(ROOT, 'node_modules', '.bin', 'electron');
const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications');
const desktopPath = path.join(desktopDir, 'markwrite.desktop');

if (!fs.existsSync(iconPath)) {
  console.error(`[linux:desktop] Missing icon: ${iconPath}`);
  process.exit(1);
}
if (!fs.existsSync(electronPath)) {
  console.error(`[linux:desktop] Missing electron binary: ${electronPath}`);
  process.exit(1);
}

fs.mkdirSync(desktopDir, { recursive: true });

const q = (s) => (s.includes(' ') ? `"${s}"` : s);
const content = [
  '[Desktop Entry]',
  'Name=MarkWrite',
  'Comment=Markdown editor with AI',
  `Exec=${q(electronPath)} ${q(ROOT)}`,
  `Icon=${iconPath}`,
  'Type=Application',
  'StartupWMClass=MarkWrite',
  'Categories=Utility;TextEditor;',
].join('\n');

let needsWrite = true;
if (fs.existsSync(desktopPath)) {
  try {
    needsWrite = fs.readFileSync(desktopPath, 'utf8') !== content;
  } catch (_) {
    needsWrite = true;
  }
}

if (needsWrite) {
  fs.writeFileSync(desktopPath, content, 'utf8');
  console.log(`[linux:desktop] Updated: ${desktopPath}`);
} else {
  console.log(`[linux:desktop] Already up to date: ${desktopPath}`);
}
