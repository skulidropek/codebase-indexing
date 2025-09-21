import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import { URL } from 'node:url';

interface ServeOptions {
  root: string;
  index: string;
  backend: string;
  ollamaModel: string;
  meiliHost: string;
  meiliPort: number;
  masterKey: string;
  containerName: string;
  dataDir: string;
  meiliImage: string;
  apiHost: string;
  apiPort: number;
}

function parseArgs(argv: string[]): ServeOptions {
  const options: ServeOptions = {
    root: process.env.REPO_ROOT ?? '.',
    index: process.env.INDEX_UID ?? 'repo',
    backend: process.env.RAG_EMBED_BACKEND ?? 'ollama',
    ollamaModel: process.env.RAG_OLLAMA_MODEL ?? 'nomic-embed-text',
    meiliHost: process.env.MEILI_HOST ?? '127.0.0.1',
    meiliPort: Number(process.env.MEILI_PORT ?? '7700'),
    masterKey: process.env.MEILI_KEY ?? 'devkey',
    containerName: process.env.MEILI_CONTAINER_NAME ?? 'meilisearch-rag',
    dataDir: process.env.MEILI_DATA_DIR ?? '.meili-data',
    meiliImage: process.env.MEILI_IMAGE ?? 'getmeili/meilisearch:v1.10',
    apiHost: process.env.RAG_SERVER_HOST ?? '127.0.0.1',
    apiPort: Number(process.env.RAG_SERVER_PORT ?? '3333')
  };

  const normalizedArgs = [...argv];
  for (let i = 0; i < normalizedArgs.length; i += 1) {
    const arg = normalizedArgs[i];
    const [key, valueFromEq] = arg.startsWith('--') ? arg.slice(2).split('=', 2) : [null, null];
    if (!key) {
      continue;
    }
    const nextValue = valueFromEq ?? normalizedArgs[i + 1];
    const value = valueFromEq ?? (nextValue && !nextValue.startsWith('--') ? nextValue : undefined);
    if (!value) {
      continue;
    }
    switch (key) {
      case 'root':
        options.root = value;
        break;
      case 'index':
        options.index = value;
        break;
      case 'backend':
        options.backend = value;
        break;
      case 'ollama-model':
        options.ollamaModel = value;
        break;
      case 'meili-host':
        options.meiliHost = value;
        break;
      case 'meili-port':
        options.meiliPort = Number(value);
        break;
      case 'master-key':
        options.masterKey = value;
        break;
      case 'container-name':
        options.containerName = value;
        break;
      case 'data-dir':
        options.dataDir = value;
        break;
      case 'meili-image':
        options.meiliImage = value;
        break;
      case 'api-host':
        options.apiHost = value;
        break;
      case 'api-port':
        options.apiPort = Number(value);
        break;
      default:
        break;
    }
    if (!valueFromEq && nextValue === value) {
      normalizedArgs.splice(i + 1, 1);
    }
  }

  return options;
}

async function waitForMeili(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch failed')) {
        // retry
      }
    }
    await delay(1_000);
  }
  throw new Error('Timed out waiting for Meilisearch to become healthy');
}

async function removeExistingContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const proc = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
    proc.on('error', () => resolve());
    proc.on('exit', () => resolve());
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolvedRoot = path.resolve(options.root);
  const resolvedDataDir = path.isAbsolute(options.dataDir)
    ? options.dataDir
    : path.join(resolvedRoot, options.dataDir);

  await fs.mkdir(resolvedDataDir, { recursive: true });

  process.env.REPO_ROOT = resolvedRoot;
  process.env.MEILI_URL = `http://${options.meiliHost}:${options.meiliPort}`;
  process.env.MEILI_KEY = options.masterKey;
  process.env.INDEX_UID = options.index;
  process.env.RAG_EMBED_BACKEND = options.backend;
  process.env.RAG_OLLAMA_MODEL = options.ollamaModel;

  await removeExistingContainer(options.containerName);

  const dockerArgs = [
    'run',
    '--rm',
    '--name',
    options.containerName,
    '-e',
    `MEILI_MASTER_KEY=${options.masterKey}`,
    '-v',
    `${resolvedDataDir}:/meili_data`
  ];

  if (options.meiliHost && options.meiliHost !== '0.0.0.0') {
    dockerArgs.push('-p', `${options.meiliHost}:${options.meiliPort}:7700`);
  } else {
    dockerArgs.push('-p', `${options.meiliPort}:7700`);
  }

  dockerArgs.push(options.meiliImage);

  const dockerProcess = spawn('docker', dockerArgs, { stdio: 'inherit' });

  let dockerStopped = false;

  dockerProcess.on('error', (error) => {
    console.error('Failed to start docker:', error instanceof Error ? error.message : error);
    process.exit(1);
  });

  const stopDocker = async () => {
    if (dockerStopped) {
      return;
    }
    dockerStopped = true;
    if (!dockerProcess.killed) {
      dockerProcess.kill('SIGINT');
      await Promise.race([
        new Promise((resolve) => dockerProcess.once('exit', resolve)),
        delay(5_000)
      ]);
    }
  };

  dockerProcess.once('exit', (code) => {
    if (!dockerStopped && code !== 0) {
      console.error('Meilisearch container exited unexpectedly');
      process.exit(1);
    }
  });

  const [{ enableVectorStore, BASE_HEADERS, MEILI_URL, INDEX_UID }, { startWatcher, indexOnce }, embedModule] = await Promise.all([
    import('./meili.js'),
    import('./indexer.js'),
    import('./embed.js')
  ]);

  await waitForMeili(MEILI_URL);
  try {
    await enableVectorStore();
  } catch (error) {
    console.error('Failed to enable vector store:', error instanceof Error ? error.message : error);
    await stopDocker();
    process.exit(1);
  }

  const logger = (payload: Record<string, unknown>) => {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }));
  };

  let watcherHandle: Awaited<ReturnType<typeof startWatcher>>;
  try {
    watcherHandle = await startWatcher(logger);
  } catch (error) {
    console.error('Failed to start watcher:', error instanceof Error ? error.message : error);
    await stopDocker();
    process.exit(1);
  }

  const apiServer = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404).end();
      return;
    }
    const requestUrl = new URL(req.url, `http://${req.headers.host ?? `${options.apiHost}:${options.apiPort}`}`);

    try {
      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', index: watcherHandle.summary }));
        return;
      }

      if (req.method === 'POST' && requestUrl.pathname === '/reindex') {
        const summary = await indexOnce(logger);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', summary }));
        return;
      }

      if (requestUrl.pathname === '/search') {
        const limitParam = requestUrl.searchParams.get('limit');
        const limit = limitParam ? Math.max(1, Number.parseInt(limitParam, 10) || 8) : 8;

        if (req.method === 'GET') {
          const query = requestUrl.searchParams.get('q');
          if (!query) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing query parameter q' }));
            return;
          }
          const vector = (await embedModule.embed(query)) as number[];
          const meiliResponse = await fetch(`${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}/search`, {
            method: 'POST',
            headers: BASE_HEADERS,
            body: JSON.stringify({ vector, limit, showRankingScore: true })
          });
          const body = await meiliResponse.text();
          res.writeHead(meiliResponse.status, { 'content-type': 'application/json' });
          res.end(body);
          return;
        }

        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const payload = JSON.parse(body ?? '{}');
              const query = payload.query ?? payload.q;
              if (typeof query !== 'string' || !query.trim()) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing query in body' }));
                return;
              }
              const vector = (await embedModule.embed(query)) as number[];
              const meiliResponse = await fetch(`${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}/search`, {
                method: 'POST',
                headers: BASE_HEADERS,
                body: JSON.stringify({ vector, limit: payload.limit ?? limit, showRankingScore: true })
              });
              const meiliBody = await meiliResponse.text();
              res.writeHead(meiliResponse.status, { 'content-type': 'application/json' });
              res.end(meiliBody);
            } catch (error) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: error instanceof Error ? error.message : error }));
            }
          });
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : error }));
    }
  });

  apiServer.on('error', async (error) => {
    logger({ event: 'error', message: 'API server failed to start', detail: error instanceof Error ? error.message : error });
    await watcherHandle.close();
    await stopDocker();
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    apiServer.listen(options.apiPort, options.apiHost, () => {
      logger({ event: 'server', message: `API listening at http://${options.apiHost}:${options.apiPort}` });
      resolve();
    });
  });

  const shutdown = async () => {
    logger({ event: 'server', message: 'Shutting down' });
    await watcherHandle.close();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await stopDocker();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
