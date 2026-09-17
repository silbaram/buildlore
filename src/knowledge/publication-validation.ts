import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { createProjectSecurityService } from '../sanitizer/index.js';
import { generatedSourceFilenameKind } from '../sanitizer/generated-identifiers.js';
import { parseSourceDocument, renderSourceDocument } from '../projector/source-document.js';
import { validateCollectionSourceIdentityBinding, validateP2aSourceIdentity } from '../projector/source-identity.js';
import { screenRetainedKnowledgeValue } from '../compiler/project-knowledge/history-security.js';
import { showProject } from './workspace.js';
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
      const sourcePrefix = `projects/${projectId}/sources/`;
      const sourceName = relativePath.startsWith(sourcePrefix) ? relativePath.slice(sourcePrefix.length) : '';
      const kind = generatedSourceFilenameKind(sourceName);
      if (kind !== null) {
        // Generated source URIs are encoded concatenations. Validate their exact
        // binding, then screen every decoded field with the unchanged policy.
        // Never exempt arbitrary prose or silently mask published bytes.
        try {
          const document = parseSourceDocument(body);
          if (renderSourceDocument(document) !== body || document.buildlore.projectId !== projectId ||
              document.buildlore.sourceKind !== kind || sourceName !== `${kind}--${sha256(document.source).slice(7)}.md`) return false;
          const repository = (await showProject(knowledgeRoot, projectId)).entry.sourceRepository;
          const identity = document.buildlore.producer === 'buildlore' &&
              (kind === 'code' || kind === 'json' || kind === 'markdown' || kind === 'text')
            ? validateCollectionSourceIdentityBinding({ documentKind: kind, projectId, repository }, document.source)
            : document.buildlore.producer === 'p2a' && (kind === 'planning' || kind === 'execution')
              ? validateP2aSourceIdentity({ projectId, repository, source: document.source, sourceKind: kind }) : null;
          if (identity === null) return false;
          const descriptor = document.buildlore.descriptor;
          const decoded = { ...document, source: identity, buildlore: { ...document.buildlore,
            ...(descriptor === undefined ? {} : { descriptor: { ...descriptor, sourceUri: identity } }) } };
          await screenRetainedKnowledgeValue(decoded, async scanBody => {
            const scanDigest = sha256(scanBody);
            const result = await service.prepareSource({ body: scanBody, bodyDigest: scanDigest, projectId,
              source: `buildlore://knowledge/${projectId}/${sha256(relativePath).slice(7)}`, sourceKind: 'wiki',
              sourceRevisionOrContentSha256: expectedDigest });
            if (!result.ok || result.report.outputDigest !== scanDigest) throw new Error('Publication source blocked.');
          });
          return true;
        } catch { return false; }
      }
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
