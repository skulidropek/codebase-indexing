import path from 'node:path';
import process from 'node:process';
import chokidar from 'chokidar';

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

async function reindexFile(rel: string, full: string): Promise<number> {
  if (!(await withinSizeLimit(full))) {
    await deleteByFilePath(rel);
    return 0;
  }
  await deleteByFilePath(rel);
  let docs: Awaited<ReturnType<typeof documentsForFile>>;
  try {
    docs = await documentsForFile(rel, full);
  } catch (error) {
    console.error(`Failed to read ${rel}:`, error);
    return 0;
  }
  if (docs.length === 0) {
    return 0;
  }
  await addDocuments(docs);
  return docs.length;
}

async function rebuildRepository(): Promise<{ files: number; chunks: number }> {
  const dimension = await getEmbeddingDimension();
  await ensureIndex(dimension);
  const ignoreMatcher = await loadIgnore(ROOT);
  let fileCount = 0;
  let chunkCount = 0;
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
        fileCount += 1;
        chunkCount += docs.length;
      }
    } catch (error) {
      console.error(`Failed to index ${file.rel}:`, error);
    }
  }
  return { files: fileCount, chunks: chunkCount };
}

async function indexOnce(): Promise<void> {
  const summary = await rebuildRepository();
  console.log(JSON.stringify({ indexedFiles: summary.files, indexedChunks: summary.chunks }));
}

function relativeFromAbsolute(full: string): string {
  return path.relative(ROOT, full).split(path.sep).join('/');
}

async function watchMode(): Promise<void> {
  let ignoreMatcher = await loadIgnore(ROOT);
  const summary = await rebuildRepository();
  console.log(JSON.stringify({ indexedFiles: summary.files, indexedChunks: summary.chunks }));

  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((error) => {
      console.error(error);
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
      const count = await reindexFile(rel, fullPath);
      console.log(JSON.stringify({ event: 'add', file: rel, chunks: count }));
    });
  });

  watcher.on('change', (fullPath) => {
    const rel = relativeFromAbsolute(fullPath);
    if (rel === '.gitignore' || rel === '.ragignore') {
      enqueue(async () => {
        ignoreMatcher = await loadIgnore(ROOT);
        const result = await rebuildRepository();
        console.log(JSON.stringify({ event: 'ignore-refresh', indexedFiles: result.files, indexedChunks: result.chunks }));
      });
      return;
    }
    if (!shouldIndex(rel)) {
      return;
    }
    enqueue(async () => {
      const count = await reindexFile(rel, fullPath);
      console.log(JSON.stringify({ event: 'change', file: rel, chunks: count }));
    });
  });

  watcher.on('unlink', (fullPath) => {
    const rel = relativeFromAbsolute(fullPath);
    enqueue(async () => {
      await deleteByFilePath(rel);
      console.log(JSON.stringify({ event: 'delete', file: rel }));
    });
  });
}

async function main() {
  if (process.argv.includes('--watch')) {
    await watchMode();
  } else {
    await indexOnce();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
