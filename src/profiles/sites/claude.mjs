// Measured selectors for claude; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'claude',
  label: 'Claude',
  hosts: ['claude.ai', 'www.claude.ai'],
  url: 'https://claude.ai/',
  composer: {
    selectors: [
      'div[data-testid="chat-input"]',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label="Write your prompt to Claude"]',
      'div.ProseMirror[contenteditable="true"]',
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
      'button[data-testid="send-button"]',
      'fieldset button[type="submit"]',
      'button[type="submit"]',
    ],
  },
  assistant: {
    containerSelectors: [
      'div[class*="prose"]',
      '[data-testid="assistant-message"]',
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
      'a[href*="/login"]',
      'button[data-testid="login-button"]',
      'input[name="email"][autocomplete="username"]',
      'form[action*="login"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: [
      '/api/organizations/',
      '/chat_conversations_v2',
      '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/',
    ],
    notes: 'The probe saw GET /api/organizations/:id/chat_conversations_v2 plus POST /claudeai-rpc/...ConversationService/:id, and the response framing is unverified.',
  },
};
