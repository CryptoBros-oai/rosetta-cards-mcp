export {
  vaultPut,
  vaultGet,
  vaultSearch,
  isPersonalArtifact,
} from "./store.js";
export type { PutResult, SearchResult, SearchHit, IndexLine } from "./store.js";

export {
  ArtifactEnvelopeSchema,
  ArtifactHashPayloadSchema,
  ArtifactKindSchema,
  ArtifactRefSchema,
  ArtifactSourceSchema,
  VaultPutInputSchema,
  VaultGetInputSchema,
  VaultSearchInputSchema,
  buildArtifactHashPayload,
  ARTIFACT_VERSION,
  PERSONAL_TAG_PREFIX,
} from "./schema.js";
export type {
  ArtifactEnvelope,
  ArtifactHashPayload,
  ArtifactKind,
  ArtifactRef,
  ArtifactSource,
} from "./schema.js";

export { computeArtifactId, assertVaultPayloadClean } from "./canon.js";
