// Measured selectors for qwen; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'qwen',
  label: 'Qwen Chat',
  hosts: ['chat.qwen.ai', 'qwen.ai'],
  url: 'https://chat.qwen.ai/',
  composer: {
    selectors: [
      'textarea#chat-input',
      'textarea[placeholder*="How can I help you today" i]',
      'div[contenteditable="true"][role="textbox"]',
      'form textarea',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    kind: 'auto',
  },
  send: {
    strategy: 'enter',
    buttonSelectors: [
      'button#send-message-button',
      'form button[type="submit"]',
      'button[type="submit"]',
    ],
  },
  assistant: {
    containerSelectors: [
      '[data-message-author-role="assistant"]',
      'div[class*="markdown"]',
      'div[class*="prose"]',
      'article',
      '[data-testid*="assistant" i]',
    ],
    streamingSelectors: [
      'button[aria-label*="stop" i]',
      '[role="button"][aria-label*="stop" i]',
      '[data-testid="stop-button"]',
      '[aria-busy="true"]',
    ],
    doneWhen: 'text-stable',
  },
  preflight: {
    authWallSelectors: [
      'a[href*="/auth"]',
      'a[href*="/login"]',
      'form[action*="login"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: ['/api/v2/users/status', '/api/v2/chats'],
    notes: 'The probe captured POST /api/v2/users/status (a Ping-type call, 2 uses) and no chat completion request, so the stream endpoint and shape are unverified.',
  },
};
