import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import ignore from 'ignore';

export const MAX_FILE_BYTES = Number(process.env.RAG_MAX_FILE_BYTES ?? 2_000_000);
const DEFAULT_IGNORES = ['node_modules', '.git', '.next', 'dist', 'build', '.meili-data'];

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function loadIgnore(root: string): Promise<ignore.Ignore> {
  const ig = ignore().add(DEFAULT_IGNORES);
  for (const name of ['.ragignore', '.gitignore']) {
    try {
      const raw = await fs.readFile(path.join(root, name), 'utf8');
      ig.add(raw.split(/\r?\n/));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return ig;
}

export async function* walk(root: string, ig: ignore.Ignore): AsyncGenerator<{ rel: string; full: string }, void, void> {
  const stack: string[] = ['.'];
  while (stack.length) {
    const relDir = stack.pop()!;
    const fullDir = path.join(root, relDir);
    const entries = await fs.readdir(fullDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = path.join(relDir, entry.name);
      const normalized = relPath.split(path.sep).join('/');
      if (normalized !== '.' && ig.ignores(normalized)) {
        continue;
      }
      const fullPath = path.join(root, relPath);
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      yield { rel: normalized, full: fullPath };
    }
  }
}

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'md', 'mdx', 'yml', 'yaml', 'toml', 'ini',
  'go', 'rs', 'py', 'java', 'kt', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp',
  'cs', 'rb', 'php', 'sql', 'sh', 'ps1', 'bat', 'swift'
]);

export function shouldIndex(rel: string): boolean {
  const ext = rel.split('.').pop()?.toLowerCase();
  return !!ext && CODE_EXTENSIONS.has(ext);
}

export async function withinSizeLimit(full: string): Promise<boolean> {
  try {
    const stats = await fs.stat(full);
    return stats.size <= MAX_FILE_BYTES;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function readFileUtf8(full: string): Promise<string> {
  return fs.readFile(full, 'utf8');
}

export function chunkByLines(text: string, maxLines = 150, overlap = 30): Array<{ start: number; end: number; text: string }> {
  if (overlap >= maxLines) {
    throw new Error('chunk overlap must be smaller than chunk length');
  }
  const lines = text.split(/\r?\n/);
  const chunks: Array<{ start: number; end: number; text: string }> = [];
  let startLine = 0;
  while (startLine < lines.length) {
    const endLine = Math.min(lines.length, startLine + maxLines);
    const slice = lines.slice(startLine, endLine);
    chunks.push({ start: startLine + 1, end: endLine, text: slice.join('\n') });
    if (endLine === lines.length) {
      break;
    }
    startLine = Math.max(0, endLine - overlap);
  }
  if (chunks.length === 0) {
    chunks.push({ start: 1, end: 1, text: '' });
  }
  return chunks;
}
