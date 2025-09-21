import process from 'node:process';

import { embed } from './embed.js';
import { BASE_HEADERS, INDEX_UID, MEILI_URL } from './meili.js';

type SearchMode = 'vector' | 'keyword' | 'hybrid';

function parseMode(value?: string | null): SearchMode {
  const normalized = (value ?? '').toLowerCase();
  if (normalized === 'keyword' || normalized === 'bm25') {
    return 'keyword';
  }
  if (normalized === 'hybrid') {
    return 'hybrid';
  }
  if (normalized === '' || normalized === 'vector') {
    return 'vector';
  }
  throw new Error(`Unsupported mode: ${value}`);
}

function parseArgs(argv: string[]): { query: string; limit: number; json: boolean; mode: SearchMode } {
  let limit = Number(process.env.RAG_SEARCH_LIMIT ?? '8');
  let json = false;
  let mode = parseMode(process.env.RAG_SEARCH_MODE ?? 'vector');
  const words: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit' || arg === '-l') {
      const next = argv[++i];
      if (!next) {
        throw new Error('Expected number after --limit');
      }
      limit = Number.parseInt(next, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error('Limit must be a positive integer');
      }
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--mode') {
      const next = argv[++i];
      if (!next) {
        throw new Error('Expected mode after --mode');
      }
      mode = parseMode(next);
      continue;
    }
    words.push(arg);
  }

  const query = words.join(' ').trim();
  if (!query) {
    throw new Error('Query text is required. Example: npm run search -- "init database"');
  }

  return { query, limit, json, mode };
}

async function search(query: string, limit: number, mode: SearchMode) {
  const body: Record<string, unknown> = { limit, showRankingScore: true };

  if (mode === 'keyword' || mode === 'hybrid') {
    body.q = query;
  }

  if (mode === 'vector' || mode === 'hybrid') {
    const vector = (await embed(query)) as number[];
    body.vector = vector;
  }

  const url = `${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}/search`;
  const response = await fetch(url, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Search failed: ${response.status} ${bodyText}`);
  }
  return response.json();
}

async function main() {
  const { query, limit, json, mode } = parseArgs(process.argv.slice(2));
  const result = await search(query, limit, mode);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!Array.isArray(result.hits)) {
    console.log('No hits.');
    return;
  }
  for (const hit of result.hits) {
    const path = hit.filePath ?? hit.path ?? 'unknown';
    const start = hit.startLine ?? hit.start ?? '?';
    const end = hit.endLine ?? hit.end ?? '?';
    const rawScore = typeof hit._rankingScore === 'number' ? hit._rankingScore : hit._score;
    let scoreText = '';
    if (typeof rawScore === 'number' && Number.isFinite(rawScore)) {
      if (mode === 'keyword') {
        scoreText = ` (score=${rawScore.toFixed(4)})`;
      } else {
        const pct = (Math.max(0, Math.min(1, rawScore)) * 100).toFixed(1);
        scoreText = ` ${pct}%`;
      }
    }
    console.log(`${path}:${start}-${end}${scoreText}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
