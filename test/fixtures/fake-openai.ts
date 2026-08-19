import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';

interface ChatRequest {
  readonly messages?: ReadonlyArray<{ readonly content?: unknown }>;
  readonly tools?: ReadonlyArray<{
    readonly function?: { readonly name?: unknown };
  }>;
}

interface EmbeddingRequest {
  readonly input?: unknown;
}

export interface FakeOpenAiServer {
  readonly baseUrl: string;
  readonly chatBodies: readonly string[];
  readonly chatCalls: number;
  close(): Promise<void>;
  readonly embeddingBodies: readonly string[];
  readonly embeddingCalls: number;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else {
      throw new Error('Fake provider received an unsupported request body.');
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

function markerFrom(body: string): 'alpha' | 'beta' | 'unknown' {
  if (body.includes('ALPHA-MARKER')) {
    return 'alpha';
  }
  if (body.includes('BETA-MARKER')) {
    return 'beta';
  }
  return 'unknown';
}

function toolArguments(name: string, body: string): Readonly<Record<string, unknown>> {
  switch (name) {
    case 'extract_concepts':
      return {
        concepts: [
          {
            concept: 'Shared Topic',
            confidence: 1,
            is_new: true,
            provenance_state: 'extracted',
            summary: `A project-isolated ${markerFrom(body)} summary.`,
            tags: ['buildlore', 'isolation'],
          },
        ],
      };
    case 'judge_citation':
      return { reason: 'The fixture source supports the claim.', score: 2 };
    case 'select_pages':
      return { pages: ['concepts/shared-topic'], reasoning: 'The page matches the question.' };
    default:
      return {};
  }
}

function chatResponse(body: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(body) as ChatRequest;
  const toolName = parsed.tools?.[0]?.function?.name;
  const message =
    typeof toolName === 'string'
      ? {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify(toolArguments(toolName, body)),
                name: toolName,
              },
              id: 'call_fixture',
              type: 'function',
            },
          ],
        }
      : {
          content:
            '## Shared Topic\n\nShared Topic is isolated to its selected BuildLore project workspace and remains independently compiled. ^[decision--shared.md:8-8]\n\n## Sources\n\n- decision--shared.md\n',
          role: 'assistant',
        };
  return {
    choices: [{ finish_reason: 'stop', index: 0, message }],
    created: 0,
    id: 'chatcmpl_fixture',
    model: 'fixture-model',
    object: 'chat.completion',
    usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
  };
}

function embeddingResponse(body: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(body) as EmbeddingRequest;
  const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
  return {
    data: inputs.map((_, index) => ({
      embedding: [1, 0, 0, 0],
      index,
      object: 'embedding',
    })),
    model: 'fixture-embedding-model',
    object: 'list',
    usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
  };
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

export async function startFakeOpenAiServer(): Promise<FakeOpenAiServer> {
  let chatCalls = 0;
  let embeddingCalls = 0;
  const chatBodies: string[] = [];
  const embeddingBodies: string[] = [];
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const body = await readBody(request);
      if (request.url === '/v1/chat/completions') {
        chatCalls += 1;
        chatBodies.push(body);
        writeJson(response, chatResponse(body));
        return;
      }
      if (request.url === '/v1/embeddings') {
        embeddingCalls += 1;
        embeddingBodies.push(body);
        writeJson(response, embeddingResponse(body));
        return;
      }
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture failure' } }));
    }
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake provider did not bind to a TCP port.');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get chatBodies() {
      return chatBodies;
    },
    get chatCalls() {
      return chatCalls;
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
    get embeddingBodies() {
      return embeddingBodies;
    },
    get embeddingCalls() {
      return embeddingCalls;
    },
  };
}
