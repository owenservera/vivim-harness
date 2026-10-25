// Measured selectors for gemini; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'gemini',
  label: 'Gemini',
  hosts: ['gemini.google.com'],
  url: 'https://gemini.google.com/app',
  composer: {
    selectors: [
      'div[data-placeholder="Ask Gemini"]',
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    kind: 'auto',
  },
  send: {
    strategy: 'enter',
    buttonSelectors: [
      'button[aria-label="Send message"]',
      'button.send-button',
      'button[type="submit"]',
    ],
  },
  assistant: {
    containerSelectors: [
      'assistant-messages-primary > div',
      'user-query, model-response',
      'model-response',
      '[data-message-author-role="assistant"]',
      'article',
      '[data-testid*="assistant" i]',
    ],
    streamingSelectors: [
      'button[aria-label*="Stop" i]',
      '[role="button"][aria-label*="Stop" i]',
      '[data-testid="stop-button"]',
      '[aria-busy="true"]',
    ],
    doneWhen: 'text-stable',
  },
  preflight: {
    authWallSelectors: [
      'a[href*="accounts.google.com"]',
      'a[href*="/signin"]',
      'form[action*="signin"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: ['/_/BardChatUi/data/batchexecute'],
    notes: 'Replies arrive as POST /_/BardChatUi/data/batchexecute batched-RPC frames (probe saw 27 calls, plus 49 cspreport posts); the payload encoding is unverified.',
  },
};
