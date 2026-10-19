// Pairwatch's types/index.d.ts augments the engine's 'claude-code' module with its PluginState.
// Outside the engine that module does not exist; this shim gives the augmentation something to merge into.
declare module 'claude-code' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface PluginState {}
}
