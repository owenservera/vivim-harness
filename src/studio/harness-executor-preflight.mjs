// AION Agent 14 / Z.ai Round 6: pure validation BEFORE invoking Studio's sole executor.
// Does not acquire a browser, initialize a runtime or execute provider calls on its own.
// The caller MUST supply a pure/synchronous validator. Never mark runtime errors safe.
export function withDispatchPreflight(toolExecutor, validate) {
  if (typeof toolExecutor !== 'function' || typeof validate !== 'function')
    throw new TypeError('Expected an existing toolExecutor and a pure validate function');
  return async ({ tool, args, ...rest }) => {
    try {
      validate(tool, args); // Existing validateConversationTool: no browser/effect.
    } catch (e) {
      const error = e instanceof Error ? e : new Error('Tool validation failed');
      error.code = error.code ?? 'INVALID_TOOL_ARGUMENTS';
      error.effectState = 'not_dispatched'; // Grounded ONLY because validation precedes execution.
      throw error;
    }
    // Errors here may have occurred after a real effect: do NOT annotate them.
    return toolExecutor({ tool, args, ...rest });
  };
}