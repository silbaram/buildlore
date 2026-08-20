import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { showProject } from '../../src/knowledge/index.js';
import {
  SECURITY_POLICY_SCHEMA_VERSION,
  serializeSecurityPolicy,
  type DataClassification,
  type SecurityEgressCapability,
  type SecurityPolicy,
} from '../../src/sanitizer/index.js';

const ALL_EGRESS_CAPABILITIES: readonly SecurityEgressCapability[] = [
  'compile',
  'context',
  'eval-full',
  'query',
  'search',
];

export async function writeSecurityPolicy(
  knowledgeRoot: string,
  projectId: string,
  options: {
    readonly capabilities?: readonly SecurityEgressCapability[];
    readonly classification?: DataClassification;
  } = {},
): Promise<void> {
  const project = await showProject(knowledgeRoot, projectId);
  const policy: SecurityPolicy = {
    schemaVersion: SECURITY_POLICY_SCHEMA_VERSION,
    projectId,
    defaultClassification: options.classification ?? 'public',
    classificationRules: [],
    egressRules: (options.capabilities ?? ALL_EGRESS_CAPABILITIES).map((capability) => ({
      allowedClassifications: ['internal', 'public'],
      capability,
    })),
    overrides: [],
  };
  await writeFile(
    join(knowledgeRoot, project.workspacePath, 'security-policy.json'),
    serializeSecurityPolicy(policy),
    'utf8',
  );
}
