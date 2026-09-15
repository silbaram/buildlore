import { hasReadControl, validReadPage } from '../application/read-validation.js';
import * as z from 'zod';
import { CliUsageError } from '../cli/parser.js';
import { ConnectionError } from '../connection/contracts.js';
import { containsCredentialMaterial } from '../sanitizer/service.js';
import type { WikiReadRequest } from '../application/wiki-read-service.js';

const text = z.string().min(1).refine(s => s.isWellFormed() && !hasReadControl(s));
const generation = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const page = text.refine(validReadPage);
const cursor = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/u);
export const toolSchemas = {
  status: z.strictObject({}),
  list: z.strictObject({ cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional(), expectedGeneration: generation.optional() }),
  search: z.strictObject({ query: text.max(8192).refine(s => /[\p{L}\p{N}]/u.test(s)), expectedGeneration: generation.optional() }),
  read: z.strictObject({ page, view: z.literal('reader').optional(), expectedGeneration: generation }),
  citations: z.strictObject({ page, expectedGeneration: generation }),
  lookup: z.strictObject({ kind: z.enum(['evidence', 'fact']), id: generation, expectedGeneration: generation }),
  memory: z.strictObject({ task: text.refine(s => s.trim().length > 0 && Buffer.byteLength(s) <= 2048).optional(),
    maxBytes: z.number().int().min(2048).max(65536).optional(), progressive: z.boolean().optional(), cursor: text.max(16384).optional(), expectedGeneration: generation.optional() }),
};
export type ToolName = keyof typeof toolSchemas;
export function isToolName(name: string): name is ToolName { return Object.hasOwn(toolSchemas, name); }
export function parseReadTool(name: ToolName, input: unknown): WikiReadRequest | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  if (containsCredentialMaterial(JSON.stringify(input))) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  if (['read', 'citations', 'lookup'].includes(name) && !Object.hasOwn(input, 'expectedGeneration')) throw new ConnectionError('GENERATION_REQUIRED');
  const result = toolSchemas[name].safeParse(input);
  if (!result.success) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  if (name === 'status') return null;
  const v = result.data;
  if ('cursor' in v && name === 'memory' && (!('progressive' in v) || !v.progressive || !('task' in v) || v.task === undefined)) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  if (name === 'memory' && !('task' in v && v.task !== undefined) && ('maxBytes' in v && v.maxBytes !== undefined || 'progressive' in v && v.progressive)) throw new CliUsageError('CLI_ARGUMENT_INVALID');
  // Zod validates every field above; omit undefined properties for exact optional types.
  return { operation: name, ...Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined)) };
}
