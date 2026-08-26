import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  callerHarnessCompatibilityDigest,
  finalizeSessionCompilePlan,
  parseSessionCompileProposal,
  parseSessionCompileProposalBytes,
  proposalDigest,
  readSessionCompileProposalFile,
  SESSION_COMPILE_LIMITS,
} from '../src/compiler/session/contracts.js';
import { sessionSha256 } from '../src/compiler/session/canonical.js';
import { createSessionTasksAndMerges } from '../src/compiler/session/planner-pure.js';
import { createProjectSessionCompilerForTest } from '../src/compiler/session/service.js';
import { SessionCompileError } from '../src/compiler/session/errors.js';
import {
  SESSION_COMPILE_ALGORITHM_VERSION,
  SESSION_COMPILE_PLAN_SCHEMA_VERSION,
  SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
  type SessionPlannedSource,
  type SessionCompileProposalV1,
} from '../src/compiler/session/types.js';
import { serializeCanonicalJson } from '../src/knowledge/atomic-file.js';

const temporaryRoots: string[] = [];
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const SOURCE_ID = `source-${'b'.repeat(64)}` as const;
const TASK_ID = `task-${'c'.repeat(64)}` as const;

function validProposal(): SessionCompileProposalV1 {
  const draft: SessionCompileProposalV1 = {
    schemaVersion: SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION,
    projectId: 'alpha',
    planDigest: DIGEST,
    proposalId: 'proposal-alpha',
    proposalDigest: DIGEST,
    taskId: TASK_ID,
    mergeCandidateIds: [],
    pageId: 'concepts/session-compile',
    slug: 'session-compile',
    title: 'Session compile',
    kind: 'concept',
    summary: 'A caller-session compilation proposal.',
    body: 'The current agent session prepares this page.',
    sources: [SOURCE_ID],
    wikilinks: [],
    citations: [],
    confidence: 0.9,
    callerHarness: {
      compatibilityDigest: callerHarnessCompatibilityDigest('codex', '1.0.0'),
      kind: 'codex',
      version: '1.0.0',
    },
  };
  return Object.freeze({ ...draft, proposalDigest: proposalDigest(draft) });
}

function proposalWith(
  overrides: Partial<SessionCompileProposalV1>,
): SessionCompileProposalV1 {
  const draft = Object.freeze({ ...validProposal(), ...overrides });
  return Object.freeze({ ...draft, proposalDigest: proposalDigest(draft) });
}

function plannedSource(index: number, body: string): SessionPlannedSource {
  const hex = index.toString(16).padStart(64, '0');
  const digest = sessionSha256(body);
  const sourceId = `source-${hex}` as const;
  return Object.freeze({
    citationAnchors: [],
    originalContentDigest: digest,
    revision: digest,
    sanitizedBody: body,
    sanitizedContentDigest: digest,
    sourceId,
    sourceKind: 'markdown',
    sourceRef: `docs/source-${String(index)}.md`,
    title: `Source ${String(index)}`,
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) =>
    rm(root, { force: true, recursive: true })));
});

describe('session compile proposal contract', () => {
  it('accepts only the exact schema, project, canonical bytes, closed keys, and proposal digest binding', () => {
    const proposal = validProposal();
    const canonical = serializeCanonicalJson(proposal);

    expect(parseSessionCompileProposal(proposal, 'alpha')).toEqual(proposal);
    expect(parseSessionCompileProposalBytes(Buffer.from(canonical), 'alpha')).toEqual(proposal);
    expect(() => parseSessionCompileProposalBytes(
      Buffer.from(JSON.stringify(proposal)),
      'alpha',
    )).toThrowError(SessionCompileError);
    expect(() => parseSessionCompileProposal(
      { ...proposal, unexpected: true },
      'alpha',
    )).toThrowError(SessionCompileError);
    expect(() => parseSessionCompileProposal(
      { ...proposal, title: 'changed after digest' },
      'alpha',
    )).toThrowError(SessionCompileError);
  });

  it('rejects duplicate JSON keys and symbolic-link proposal files', async () => {
    const proposal = validProposal();
    const duplicate = serializeCanonicalJson(proposal).replace(
      '{\n',
      `{\n  "schemaVersion": "${SESSION_COMPILE_PROPOSAL_SCHEMA_VERSION}",\n`,
    );
    expect(() => parseSessionCompileProposalBytes(Buffer.from(duplicate), 'alpha'))
      .toThrowError(SessionCompileError);

    const root = await mkdtemp(join(process.cwd(), '.test-tmp-session-contract-'));
    temporaryRoots.push(root);
    const target = join(root, 'proposal.json');
    const link = join(root, 'proposal-link.json');
    await writeFile(target, serializeCanonicalJson(proposal), 'utf8');
    await symlink(target, link);
    await expect(readSessionCompileProposalFile(link, 'alpha')).rejects.toMatchObject({
      code: 'SESSION_CONTRACT_INVALID',
    });
  });

  it('rejects BOM, CRLF, missing LF, noncanonical numbers, malformed UTF-8, excessive depth, and proposal byte overflow', () => {
    const canonical = serializeCanonicalJson(validProposal());
    const invalidInputs = [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical)]),
      Buffer.from(canonical.replaceAll('\n', '\r\n')),
      Buffer.from(canonical.slice(0, -1)),
      Buffer.from(canonical.replace('"confidence": 0.9', '"confidence": 0.90')),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('{"a":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}\n'),
      Buffer.alloc(SESSION_COMPILE_LIMITS.maxProposalBytes + 1, 0x20),
    ];

    for (const bytes of invalidInputs) {
      expect(() => parseSessionCompileProposalBytes(bytes, 'alpha'))
        .toThrowError(SessionCompileError);
    }
  });

  it('rejects duplicate ids and source, page, quote, citation, link, merge, profile-field, task, batch, and plan limit overflow without partial validation', async () => {
    const citation = {
      file: 'docs/evidence.md',
      id: 'citation-0000',
      line: 1,
      quote: 'Evidence.',
      sourceId: SOURCE_ID,
    } as const;
    const invalid = [
      proposalWith({
        citations: [citation, citation],
      }),
      proposalWith({
        sources: Array.from({ length: SESSION_COMPILE_LIMITS.maxSources + 1 }, (_, index) =>
          `source-${index.toString(16).padStart(64, '0')}` as const),
      }),
      proposalWith({ body: 'x'.repeat(100_001) }),
      proposalWith({
        citations: [{ ...citation, quote: 'q'.repeat(SESSION_COMPILE_LIMITS.maxQuoteCodeUnits + 1) }],
      }),
      proposalWith({
        citations: Array.from(
          { length: SESSION_COMPILE_LIMITS.maxCitationsPerPage + 1 },
          (_, index) => ({ ...citation, id: `citation-${index.toString().padStart(4, '0')}` }),
        ),
      }),
      proposalWith({
        wikilinks: Array.from(
          { length: SESSION_COMPILE_LIMITS.maxLinksPerPage + 1 },
          (_, index) => `link-${index.toString().padStart(4, '0')}`,
        ),
      }),
      proposalWith({
        mergeCandidateIds: Array.from(
          { length: SESSION_COMPILE_LIMITS.maxMergeCandidates + 1 },
          (_, index) => `merge-${index.toString(16).padStart(64, '0')}` as const,
        ),
      }),
      proposalWith({
        profileFields: Object.fromEntries(Array.from({ length: 129 }, (_, index) =>
          [`Field${index.toString().padStart(3, '0')}`, true])),
      }),
    ];
    for (const proposal of invalid) {
      expect(() => parseSessionCompileProposal(proposal, 'alpha'))
        .toThrowError(SessionCompileError);
    }

    const compiler = createProjectSessionCompilerForTest({
      admission: { stage: () => Promise.reject(new Error('must not run')) },
      hubRoot: '/unused',
      knowledgeRoot: '/unused',
      planner: { create: () => Promise.reject(new Error('must not run')) },
    });
    await expect(compiler.apply({
      projectId: 'alpha',
      proposalFiles: Array.from(
        { length: SESSION_COMPILE_LIMITS.maxProposals + 1 },
        (_, index) => `proposal-${String(index)}.json`,
      ),
    })).rejects.toMatchObject({ code: 'SESSION_CONTRACT_INVALID' });

    const tooManyTasks = plannedSource(
      1,
      Array.from({ length: SESSION_COMPILE_LIMITS.maxTasks + 1 }, (_, index) =>
        `# Heading ${String(index)}\nbody`).join('\n'),
    );
    expect(() => createSessionTasksAndMerges([tooManyTasks], 'default', 'alpha'))
      .toThrowError(SessionCompileError);

    const planSource = plannedSource(2, 'x'.repeat(SESSION_COMPILE_LIMITS.maxPlanBytes));
    expect(() => finalizeSessionCompilePlan({
      schemaVersion: SESSION_COMPILE_PLAN_SCHEMA_VERSION,
      projectId: 'alpha',
      contractDigest: DIGEST,
      profileDigest: DIGEST,
      policyDigest: DIGEST,
      selectionDigest: DIGEST,
      sourceManifestDigest: DIGEST,
      existingKnowledgeDigest: DIGEST,
      algorithmVersion: SESSION_COMPILE_ALGORITHM_VERSION,
      limits: SESSION_COMPILE_LIMITS,
      sources: [planSource],
      tasks: [],
      mergeCandidates: [],
      allowedLinkTargets: [],
    })).toThrowError(SessionCompileError);
  });

  it('publishes closed schemas with the normative versions and bounds', async () => {
    const schemaNames = [
      'compile-plan.schema.json',
      'compile-proposal.schema.json',
      'compile-apply-result.schema.json',
      'session-compile-provenance.schema.json',
    ];
    const schemas = await Promise.all(schemaNames.map(async (name) => JSON.parse(
      await readFile(new URL(`../schemas/${name}`, import.meta.url), 'utf8'),
    ) as Record<string, unknown>));

    expect(schemas.every((schema) => schema.additionalProperties === false)).toBe(true);
    expect((schemas[0]?.properties as Record<string, unknown>).schemaVersion).toEqual({
      const: 'buildlore.compile-plan.v1',
    });
    expect((schemas[1]?.properties as Record<string, unknown>).schemaVersion).toEqual({
      const: 'buildlore.compile-proposal.v1',
    });
    expect(((schemas[1]?.properties as Record<string, unknown>).citations as
      Record<string, unknown>).maxItems).toBe(512);
    expect(((schemas[1]?.properties as Record<string, unknown>).sources as
      Record<string, unknown>).uniqueItems).toBe(true);
    expect((((schemas[1]?.properties as Record<string, unknown>).profileFields as
      Record<string, unknown>).additionalProperties as Record<string, unknown>).oneOf)
      .toContainEqual({
        maximum: Number.MAX_SAFE_INTEGER,
        minimum: -Number.MAX_SAFE_INTEGER,
        type: 'number',
      });
    const proposalDefinitions = schemas[1]?.$defs as Record<string, Record<string, unknown>>;
    expect(proposalDefinitions.decisionProfileFields?.required).toEqual(['status']);
    expect((proposalDefinitions.decisionProfileFields?.properties as
      Record<string, Record<string, unknown>>).status?.const).toBe('active');
    expect(proposalDefinitions.failureProfileFields?.required).toEqual([
      'failureClass',
      'status',
    ]);
    expect(proposalDefinitions.verificationProfileFields?.required).toEqual([
      'evidenceRefs',
      'status',
      'verificationKind',
    ]);
    expect(schemas[1]?.allOf).toHaveLength(4);
    expect(((schemas[2]?.properties as Record<string, unknown>).admissionKind as
      Record<string, unknown>).const).toBe('untrusted-okf');
    expect(((schemas[2]?.properties as Record<string, unknown>).warnings as
      Record<string, unknown>).maxItems).toBe(32);
    expect((schemas[3]?.properties as Record<string, unknown>).schemaVersion).toEqual({
      const: 'buildlore.session-compile-provenance.v1',
    });
  });
});
