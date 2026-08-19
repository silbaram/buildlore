import type {
  CompilerCapabilityDescriptor,
  CompilerCapabilityName,
  CompilerRequest,
  EgressCapability,
} from './types.js';

export const COMPILER_CAPABILITIES: Readonly<
  Record<CompilerCapabilityName, CompilerCapabilityDescriptor>
> = Object.freeze({
  compile: descriptor('compile', 'required', 'content-write', 'source-to-generation-provider', 'compile'),
  context: descriptor(
    'context',
    'conditional',
    'none',
    'prompt-to-embedding-provider',
    'getContextPack',
  ),
  'eval-fast': descriptor('eval-fast', 'none', 'none', 'none', 'runEval'),
  'eval-full': descriptor(
    'eval-full',
    'required',
    'cache-write',
    'citation-evidence-to-judge',
    'runEval',
  ),
  lint: descriptor('lint', 'none', 'none', 'none', 'lint'),
  query: descriptor(
    'query',
    'required',
    'log-write',
    'question-and-wiki-to-provider',
    'query',
  ),
  search: descriptor(
    'search',
    'required',
    'none',
    'question-and-wiki-to-provider',
    'search',
  ),
  status: descriptor('status', 'none', 'none', 'none', 'status'),
});

function descriptor(
  capability: CompilerCapabilityName,
  provider: CompilerCapabilityDescriptor['provider'],
  workspaceEffect: CompilerCapabilityDescriptor['workspaceEffect'],
  egress: CompilerCapabilityDescriptor['egress'],
  upstreamMethod: string,
): CompilerCapabilityDescriptor {
  return Object.freeze({
    activeCancellation: false,
    capability,
    egress,
    fallback: 'none',
    overallTimeout: false,
    progress: 'none',
    provider,
    transport: 'sdk',
    upstreamMethod,
    workspaceEffect,
  });
}

export function requiresEgress(
  request: CompilerRequest,
): request is CompilerRequest & { readonly capability: EgressCapability } {
  return (
    COMPILER_CAPABILITIES[request.capability].provider === 'required' ||
    (request.capability === 'context' && request.topChunks !== 0)
  );
}
