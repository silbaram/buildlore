export { connectProject, disconnectProject, resolveConnection, setupHub, relocateHub } from './service.js';
export type { HubRelocationInput, HubRelocationPlan } from './service.js';
export type { ConnectionContext, ConnectionOptions } from './service.js';
export { ConnectionError, parseConnection, parseRegistry } from './contracts.js';
export type { SharedConnection, ReadRegistry, ConnectionErrorCode } from './contracts.js';
