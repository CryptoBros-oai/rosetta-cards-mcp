export { embed, embedSingle, isEndpointAvailable, getModelInfo } from "./client.js";
export {
  getEmbeddingsDb,
  closeEmbeddingsDb,
  upsertEmbedding,
  getEmbedding,
  hasEmbedding,
  getMissingIds,
  findSimilar,
  cosineSimilarity,
  vectorToBlob,
  blobToVector,
} from "./store.js";
export type { SimilarityHit } from "./store.js";
