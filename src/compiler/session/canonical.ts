import { createHash } from 'node:crypto';

import { serializeCanonicalJson } from '../../knowledge/atomic-file.js';
import type { SessionSha256Digest } from './types.js';

export function sessionSha256(value: string | Uint8Array): SessionSha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalSessionJson(value: unknown): string {
  return serializeCanonicalJson(value);
}

export function digestSessionValue(value: unknown): SessionSha256Digest {
  return sessionSha256(canonicalSessionJson(value));
}

export function compareSessionText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
