const meiliUrl = process.env.MEILI_URL;
const meiliKey = process.env.MEILI_KEY;
const indexUid = process.env.INDEX_UID;

if (!meiliUrl) {
  throw new Error('MEILI_URL is required');
}
if (!indexUid) {
  throw new Error('INDEX_UID is required');
}

export const MEILI_URL = meiliUrl;
export const MEILI_KEY = meiliKey ?? '';
export const INDEX_UID = indexUid;
export const EMBEDDER_NAME = process.env.MEILI_EMBEDDER_NAME ?? 'code';

export const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json'
};
if (meiliKey) {
  BASE_HEADERS.Authorization = `Bearer ${meiliKey}`;
}

const DEFAULT_BATCH_SIZE = Number(process.env.RAG_BATCH_SIZE ?? '64');

async function createIndexIfNeeded(): Promise<void> {
  const sanitized = MEILI_URL.replace(/\/$/, '');
  const indexUrl = `${sanitized}/indexes/${INDEX_UID}`;
  const lookup = await fetch(indexUrl, { headers: BASE_HEADERS, method: 'GET' });
  if (lookup.ok) {
    return;
  }
  if (lookup.status !== 404) {
    const body = await lookup.text();
    throw new Error(`Failed to fetch index info: ${lookup.status} ${body}`);
  }
  const createResponse = await fetch(`${sanitized}/indexes`, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ uid: INDEX_UID, primaryKey: 'id' })
  });
  if (!createResponse.ok && createResponse.status !== 409) {
    const body = await createResponse.text();
    throw new Error(`Failed to create index: ${createResponse.status} ${body}`);
  }
}

export async function ensureIndex(dimensions: number): Promise<void> {
  await createIndexIfNeeded();
  const indexUrl = `${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}`;
  const settingsBody = {
    embedders: {
      [EMBEDDER_NAME]: {
        source: 'userProvided',
        dimensions
      }
    },
    filterableAttributes: ['filePath']
  };
  const settingsResponse = await fetch(`${indexUrl}/settings`, {
    method: 'PATCH',
    headers: BASE_HEADERS,
    body: JSON.stringify(settingsBody)
  });
  if (!settingsResponse.ok) {
    const body = await settingsResponse.text();
    throw new Error(`Failed to configure index settings: ${settingsResponse.status} ${body}`);
  }
}

export async function addDocuments(docs: unknown[], batchSize = DEFAULT_BATCH_SIZE): Promise<void> {
  if (docs.length === 0) {
    return;
  }
  const url = `${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}/documents`;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const response = await fetch(url, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify(batch)
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to add documents: ${response.status} ${body}`);
    }
  }
}

export async function deleteByFilePath(filePath: string): Promise<void> {
  const url = `${MEILI_URL.replace(/\/$/, '')}/indexes/${INDEX_UID}/documents/delete`;
  const response = await fetch(url, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ filter: `filePath = "${filePath.replace(/"/g, '\\"')}"` })
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`Failed to delete by file path: ${response.status} ${body}`);
  }
}
