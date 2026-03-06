'use strict';

const fs = require('fs').promises;
const path = require('path');

/**
 * 文档 Agent 的工具定义
 * 作用域限定在 workDir 内，供 Agent Loop 使用
 *
 * 当使用 OpenCode 时，这些工具由 OpenCode 提供；
 * 此处定义用于 standalone 模式或文档参考
 */
const TOOL_DEFS = {
  read: {
    description: '读取文件内容。用于查看当前文档状态。',
    parameters: {
      filePath: { type: 'string', description: '文件路径，相对于工作目录或绝对路径' },
    },
  },
  edit: {
    description: '局部修改文件：将 oldString 替换为 newString。',
    parameters: {
      filePath: { type: 'string', description: '文件路径' },
      oldString: { type: 'string', description: '要替换的原文（需精确匹配）' },
      newString: { type: 'string', description: '替换后的新文' },
      replaceAll: { type: 'boolean', description: '是否替换所有出现（默认 false）' },
    },
  },
  write: {
    description: '将完整内容写入文件。用于整体重写或新建文件。',
    parameters: {
      filePath: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
  },
};

function resolvePath(filePath, workDir) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(workDir || process.cwd(), filePath);
}

async function readFile(filePath, workDir) {
  const abs = resolvePath(filePath, workDir);
  const content = await fs.readFile(abs, 'utf8');
  return { content, path: abs };
}

async function editFile(filePath, oldString, newString, replaceAll, workDir) {
  const abs = resolvePath(filePath, workDir);
  let content = await fs.readFile(abs, 'utf8');
  if (replaceAll) {
    content = content.split(oldString).join(newString);
  } else {
    if (!content.includes(oldString)) {
      throw new Error(`未找到要替换的原文: "${oldString.slice(0, 50)}..."`);
    }
    content = content.replace(oldString, newString);
  }
  await fs.writeFile(abs, content, 'utf8');
  return { path: abs, modified: true };
}

async function writeFile(filePath, content, workDir) {
  const abs = resolvePath(filePath, workDir);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return { path: abs, modified: true };
}

module.exports = {
  TOOL_DEFS,
  readFile,
  editFile,
  writeFile,
  resolvePath,
};
