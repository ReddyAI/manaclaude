/**
 * @manaclaude/connectors: the registry plus one adapter per provider, each
 * implementing ConnectorAdapter from @manaclaude/shared. Session D owns this
 * package. Adapters run in the Worker; the app imports only ./registry.
 */
export * from './registry';
export * from './adapters';
export * from './errors';
export * from './slots';
export * from './health';
export * from './sync';
