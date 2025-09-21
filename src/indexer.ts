import path from 'node:path';
import process from 'node:process';
import chokidar, { type FSWatcher } from 'chokidar';

import { embed, getEmbeddingDimension } from './embed.js';
import {
  sha256,
  loadIgnore,
  walk,
  shouldIndex,
  withinSizeLimit,
  readFileUtf8,
  chunkByLines
} from './fsutil.js';
import { addDocuments, deleteByFilePath, ensureIndex, EMBEDDER_NAME } from './meili.js';

const ROOT = path.resolve(process.env.REPO_ROOT ?? '.');
const CHUNK_LINES = Number(process.env.RAG_CHUNK_LINES ?? '150');
const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP ?? '30');

export interface IndexSummary {
  indexedFiles: number;
  indexedChunks: number;
}

type Logger = (payload: Record<string, unknown>) => void;

const defaultLogger: Logger = (payload) => {
  console.log(JSON.stringify(payload));
};

function buildDocumentId(filePath: string, start: number, end: number, fileHash: string): string {
  return sha256(`${filePath}:${start}:${end}:${fileHash}`);
}

async function documentsForFile(rel: string, full: string) {
  const content = await readFileUtf8(full);
  const chunks = chunkByLines(content, CHUNK_LINES, CHUNK_OVERLAP);
  const vectors = (await embed(chunks.map((chunk) => chunk.text))) as number[][];
  const fileHash = sha256(content);
  return chunks.map((chunk, index) => ({
    id: buildDocumentId(rel, chunk.start, chunk.end, fileHash),
    filePath: rel,
    startLine: chunk.start,
    endLine: chunk.end,
    content: chunk.text,
    _vectors: { [EMBEDDER_NAME]: vectors[index] }
  }));
}

async function reindexFile(rel: string, full: string, logger: Logger): Promise<number> {
  if (!(await withinSizeLimit(full))) {
    await deleteByFilePath(rel);
    return 0;
  }
  await deleteByFilePath(rel);
  let docs: Awaited<ReturnType<typeof documentsForFile>>;
  try {
    docs = await documentsForFile(rel, full);
  } catch (error) {
    logger({ event: 'error', file: rel, message: 'Failed to read file', detail: error instanceof Error ? error.message : error });
    return 0;
  }
  if (docs.length === 0) {
    return 0;
  }
  await addDocuments(docs);
  return docs.length;
}

async function rebuildRepository(logger: Logger): Promise<IndexSummary> {
  const dimension = await getEmbeddingDimension();
  await ensureIndex(dimension);
  const ignoreMatcher = await loadIgnore(ROOT);
  let indexedFiles = 0;
  let indexedChunks = 0;
  for await (const file of walk(ROOT, ignoreMatcher)) {
    if (!shouldIndex(file.rel)) {
      continue;
    }
    if (!(await withinSizeLimit(file.full))) {
      await deleteByFilePath(file.rel);
      continue;
    }
    try {
      const docs = await documentsForFile(file.rel, file.full);
      await deleteByFilePath(file.rel);
      if (docs.length) {
        await addDocuments(docs);
        indexedFiles += 1;
        indexedChunks += docs.length;
      }
    } catch (error) {
      logger({ event: 'error', file: file.rel, message: 'Failed to index file', detail: error instanceof Error ? error.message : error });
    }
  }
  return { indexedFiles, indexedChunks };
}

export async function indexOnce(logger: Logger = defaultLogger): Promise<IndexSummary> {
  const summary = await rebuildRepository(logger);
  logger({ event: 'index', phase: 'complete', ...summary });
  return summary;
}

function relativeFromAbsolute(full: string): string {
  return path.relative(ROOT, full).split(path.sep).join('/');
}

export interface WatcherHandle {
  watcher: FSWatcher;
  close: () => Promise<void>;
  summary: IndexSummary;
}

export async function startWatcher(logger: Logger = defaultLogger): Promise<WatcherHandle> {
  let ignoreMatcher = await loadIgnore(ROOT);
  const summary = await rebuildRepository(logger);
  logger({ event: 'index', phase: 'initial', ...summary });

  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error) => {
      logger({ event: 'error', message: error instanceof Error ? error.message : error });
    });
    return queue;
  };

  const watcher = chokidar.watch(ROOT, {
    ignored: (filePath) => {
      const rel = relativeFromAbsolute(filePath);
      if (!rel || rel.startsWith('..')) {
        return false;
      }
      return ignoreMatcher.ignores(rel);
    },
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50
    }
  });

  watcher.on('add', (fullPath) => {
    const rel = relativeFromAbsolute(fullPath);
    if (!shouldIndex(rel)) {
      return;
    }
    enqueue(async () => {
      const count = await reindexFile(rel, fullPath, logger);
      logger({ event: 'file', action: 'add', file: rel, chunks: count });
    });
  });

  watcher.on('change', (fullPath) => {
    const rel = relativeFromAbsolute(fullPath);
    if (rel === '.gitignore' || rel === '.ragignore') {
      enqueue(async () => {
        ignoreMatcher = await loadIgnore(ROOT);
        const result = await rebuildRepository(logger);
        logger({ event: 'index', phase: 'ignore-refresh', ...result });
      });
      return;
    }
    if (!shouldIndex(rel)) {
      return;
    }
    enqueue(async () => {
      const count = await reindexFile(rel, fullPath, logger);
      logger({ event: 'file', action: 'change', file: rel, chunks: count });
    });
  });

  watcher.on('unlink', (fullPath) => {
    const rel = relativeFromAbsolute(fullPath);
    enqueue(async () => {
      await deleteByFilePath(rel);
      logger({ event: 'file', action: 'delete', file: rel });
    });
  });

  const close = async () => {
    await watcher.close();
  };

  return { watcher, close, summary };
}

async function cliMain() {
  if (process.argv.includes('--watch')) {
    await startWatcher();
    await new Promise(() => {
      /* keep process alive */
    });
  } else {
    await indexOnce();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cliMain().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
