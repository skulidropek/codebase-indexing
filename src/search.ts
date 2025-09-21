import process from 'node:process';

import { embed } from './embed.js';
import { BASE_HEADERS, INDEX_UID, MEILI_URL } from './meili.js';

function parseArgs(argv: string[]): { query: string; limit: number; json: boolean } {
  let limit = Number(process.env.RAG_SEARCH_LIMIT ?? '8');
  let json = false;
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
    words.push(arg);
  }

  const query = words.join(' ').trim();
  if (!query) {
    throw new Error('Query text is required. Example: npm run search -- "init database"');
  }

  return { query, limit, json };
}

async function search(query: string, limit: number) {
  const vector = (await embed(query)) as number[];
  const url = `${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}/search`;
  const response = await fetch(url, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ vector, limit })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Search failed: ${response.status} ${body}`);
  }
  return response.json();
}

async function main() {
  const { query, limit, json } = parseArgs(process.argv.slice(2));
  const result = await search(query, limit);
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
    const pct = typeof rawScore === 'number' ? ` ${(Math.max(0, Math.min(1, rawScore)) * 100).toFixed(1)}%` : '';
    console.log(`${path}:${start}-${end}${pct}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
