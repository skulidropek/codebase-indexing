import type { FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';

const BACKEND = (process.env.RAG_EMBED_BACKEND ?? 'transformers').toLowerCase();
const MODEL_NAME = process.env.RAG_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5';
const OLLAMA_MODEL = process.env.RAG_OLLAMA_MODEL ?? 'nomic-embed-text';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');

type FeatureExtractionFactory = (task: 'feature-extraction', model?: string) => Promise<FeatureExtractionPipeline>;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let pipelineFactoryPromise: Promise<FeatureExtractionFactory> | null = null;
let cachedDim: number | null = null;

async function getPipelineFactory(): Promise<FeatureExtractionFactory> {
  if (!pipelineFactoryPromise) {
    pipelineFactoryPromise = import('@huggingface/transformers').then((mod) => mod.pipeline as unknown as FeatureExtractionFactory);
  }
  return pipelineFactoryPromise;
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    const factory = await getPipelineFactory();
    extractorPromise = factory('feature-extraction', MODEL_NAME);
  }
  return extractorPromise;
}

async function embedWithTransformers(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor();
  const output = (await extractor(texts, { pooling: 'mean', normalize: true })) as Tensor;
  const list = output.tolist() as number[][];
  return list;
}

async function embedWithOllama(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embedding failed: ${response.status} ${body}`);
    }
    const json = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error('Ollama response missing embedding array');
    }
    results.push(json.embedding);
  }
  return results;
}

async function runBackend(texts: string[]): Promise<number[][]> {
  if (BACKEND === 'ollama') {
    return embedWithOllama(texts);
  }
  return embedWithTransformers(texts);
}

export async function embed(text: string): Promise<number[]>;
export async function embed(texts: string[]): Promise<number[][]>;
export async function embed(textOrTexts: string | string[]): Promise<number[] | number[][]> {
  const items = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
  const vectors = await runBackend(items);
  const dim = vectors[0]?.length ?? 0;
  if (!cachedDim && dim > 0) {
    cachedDim = dim;
  }
  return Array.isArray(textOrTexts) ? vectors : vectors[0] ?? [];
}

export async function getEmbeddingDimension(): Promise<number> {
  if (cachedDim && cachedDim > 0) {
    return cachedDim;
  }
  const probe = await embed('dimension probe');
  const dim = Array.isArray(probe) ? (probe as number[]).length : 0;
  if (!dim) {
    throw new Error('Unable to determine embedding dimension.');
  }
  cachedDim = dim;
  return cachedDim;
}
