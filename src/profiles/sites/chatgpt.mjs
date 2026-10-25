// Measured selectors for chatgpt; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'],
  url: 'https://chatgpt.com/',
  composer: {
    selectors: [
      'form div[contenteditable="true"]',
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      '[data-testid="prompt-textarea"]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    kind: 'auto',
  },
  send: {
    strategy: 'enter',
    buttonSelectors: [
      'button[data-testid="send-button"]',
      '#composer-submit-button',
      'form button[type="submit"]',
      'button[type="submit"]',
    ],
  },
  assistant: {
    containerSelectors: [
      '[data-markdown-text-style="assistant-message"]',
      '[data-content-search-unit-key$="assistant"]',
      '[data-chatgpt-search-unit-key$="assistant"]',
      '[data-message-author-role="assistant"]',
      'article',
      '[data-testid*="assistant" i]',
    ],
    streamingSelectors: [
      '[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])',
      '[data-testid="stop-button"]',
      'button[aria-label*="Detener" i]',
      'button[aria-label*="Stop" i]',
      '[aria-busy="true"]',
    ],
    doneWhen: 'marker-gone',
  },
  preflight: {
    authWallSelectors: [
      '[data-testid="login-button"]',
      'a[href*="/auth/login"]',
      'button[data-testid="welcome-login"]',
      'form[action*="login"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: ['/backend-api/conversation', '/backend-api/f/conversation', '/backend-api/conversation/init'],
    notes: 'Conversation turns POST to /backend-api/* (probe also saw POST /ces/v1/rgstr and one wss://codex-cloud-backend websocket); the reply body is a stream whose exact shape is unverified.',
  },
};
