import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

interface StatusOptions {
  meiliUrl: string;
  masterKey: string;
  index: string;
  root: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): StatusOptions {
  const options: StatusOptions = {
    meiliUrl: process.env.MEILI_URL ?? 'http://127.0.0.1:7700',
    masterKey: process.env.MEILI_KEY ?? 'devkey',
    index: process.env.INDEX_UID ?? 'repo',
    root: process.env.REPO_ROOT ?? '.',
    dataDir: process.env.MEILI_DATA_DIR
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const [flag, inline] = arg.slice(2).split('=', 2);
    const nextValue = inline ?? args[i + 1];
    const value = inline ?? (nextValue && !nextValue.startsWith('--') ? nextValue : undefined);
    if (!value) {
      continue;
    }
    switch (flag) {
      case 'meili-url':
        options.meiliUrl = value;
        break;
      case 'master-key':
        options.masterKey = value;
        break;
      case 'index':
        options.index = value;
        break;
      case 'root':
        options.root = value;
        break;
      case 'data-dir':
        options.dataDir = value;
        break;
      default:
        break;
    }
    if (!inline && nextValue === value) {
      args.splice(i + 1, 1);
    }
  }

  return options;
}

async function directorySize(target: string): Promise<number> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      return stat.size;
    }
    const entries = await fs.readdir(target);
    let total = stat.size;
    for (const entry of entries) {
      total += await directorySize(path.join(target, entry));
    }
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed ${response.status}: ${body}`);
  }
  return response.json() as Promise<T>;
}

interface IndexMeta {
  uid: string;
  createdAt: string;
  updatedAt: string;
  primaryKey: string | null;
}

interface IndexStats {
  numberOfDocuments: number;
  isIndexing: boolean;
  fieldDistribution: Record<string, number>;
}

interface TaskInfo {
  uid: number;
  status: string;
  type: string;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  duration: string | null;
  error: { message: string } | null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.MEILI_URL = options.meiliUrl;
  process.env.MEILI_KEY = options.masterKey;
  process.env.INDEX_UID = options.index;
  process.env.REPO_ROOT = options.root;

  const { MEILI_URL, INDEX_UID, BASE_HEADERS } = await import('./meili.js');

  const indexUrl = `${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}`;
  const statsUrl = `${indexUrl}/stats`;
  const tasksUrl = `${MEILI_URL.replace(/\/$/, '')}/tasks?indexUid=${encodeURIComponent(INDEX_UID)}&limit=5&from=0`;

  const [meta, stats, tasks] = await Promise.all([
    fetchJson<IndexMeta>(indexUrl, BASE_HEADERS),
    fetchJson<IndexStats>(statsUrl, BASE_HEADERS),
    fetchJson<{ results: TaskInfo[] }>(tasksUrl, BASE_HEADERS).catch(() => ({ results: [] }))
  ]);

  const resolvedRoot = path.resolve(options.root);
  const resolvedDataDir = options.dataDir
    ? (path.isAbsolute(options.dataDir) ? options.dataDir : path.join(resolvedRoot, options.dataDir))
    : path.join(resolvedRoot, '.meili-data');

  const dataSize = await directorySize(resolvedDataDir);

  const summary = {
    meiliUrl: MEILI_URL,
    indexUid: INDEX_UID,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    primaryKey: meta.primaryKey,
    documents: stats.numberOfDocuments,
    isIndexing: stats.isIndexing,
    fields: stats.fieldDistribution,
    databasePath: resolvedDataDir,
    databaseSizeBytes: dataSize,
    recentTasks: tasks.results.map(({ uid, status, type, enqueuedAt, startedAt, finishedAt, duration, error }) => ({
      uid,
      status,
      type,
      enqueuedAt,
      startedAt,
      finishedAt,
      duration,
      error: error?.message ?? null
    }))
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
