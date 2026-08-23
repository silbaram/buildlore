import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { createProjectSecurityService } from '../sanitizer/index.js';
import { serializeCanonicalJson } from './atomic-file.js';
import type {
  PublicationBlobPolicyPort,
  PublicationDigest,
  RegistrationManifestEntry,
} from './publication-types.js';
import { parseKnowledgeManifest } from './validation.js';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function sha256(value: Buffer | string): PublicationDigest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function verifyCanonicalManifestRegistration(
  beforeBytes: Buffer,
  afterBytes: Buffer,
  projectId: string,
): RegistrationManifestEntry | null {
  let beforeValue: unknown;
  let afterValue: unknown;
  try {
    beforeValue = JSON.parse(utf8Decoder.decode(beforeBytes)) as unknown;
    afterValue = JSON.parse(utf8Decoder.decode(afterBytes)) as unknown;
  } catch {
    return null;
  }
  let before;
  let after;
  try {
    before = parseKnowledgeManifest(beforeValue);
    after = parseKnowledgeManifest(afterValue);
  } catch {
    return null;
  }
  if (
    serializeCanonicalJson(before) !== utf8Decoder.decode(beforeBytes) ||
    serializeCanonicalJson(after) !== utf8Decoder.decode(afterBytes)
  ) return null;
  const added = after.projects.filter((entry) =>
    !before.projects.some((prior) => prior.projectId === entry.projectId));
  if (added.length !== 1 || added[0]?.projectId !== projectId) return null;
  if (before.projects.some((entry) => entry.projectId === projectId)) return null;
  if (after.projects.length !== before.projects.length + 1) return null;
  for (const prior of before.projects) {
    const current = after.projects.find((entry) => entry.projectId === prior.projectId);
    if (current === undefined || serializeCanonicalJson(current) !== serializeCanonicalJson(prior)) {
      return null;
    }
  }
  return {
    contentSha256: sha256(afterBytes),
    registeredProjectId: projectId,
    relativePath: 'manifest.json',
  };
}

export function createPublicationBlobPolicy(
  knowledgeRoot: string,
): PublicationBlobPolicyPort {
  const service = createProjectSecurityService({ knowledgeRoot });
  return {
    async validate(
      projectId: string,
      relativePath: string,
      content: Buffer,
      expectedDigest: PublicationDigest,
    ): Promise<boolean> {
      let body: string;
      try {
        body = utf8Decoder.decode(content);
      } catch {
        return false;
      }
      if (sha256(Buffer.from(body, 'utf8')) !== expectedDigest) return false;
      const result = await service.prepareSource({
        body,
        bodyDigest: expectedDigest,
        projectId,
        source: `buildlore://knowledge/${projectId}/${sha256(relativePath).slice(7)}`,
        sourceKind: 'wiki',
        sourceRevisionOrContentSha256: expectedDigest,
      });
      return result.ok && result.report.outputDigest === expectedDigest;
    },
  };
}
