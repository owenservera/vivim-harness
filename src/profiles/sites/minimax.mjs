// Measured selectors for minimax; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'minimax',
  label: 'MiniMax',
  hosts: ['agent.minimax.cn', 'minimax.io', 'chat.minimax.io'],
  url: 'https://agent.minimax.cn/',
  composer: {
    selectors: [
      'div[data-testid="message-textarea"]',
      'form div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    kind: 'auto',
  },
  send: {
    strategy: 'enter',
    buttonSelectors: [
      'div[data-testid="send-button"]',
      'button[type="submit"]',
      'form button:last-of-type',
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
      'a[href*="/login"]',
      'a[href*="/signin"]',
      'form[action*="login"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: [],
    notes: 'The probe saw only static CDN chunks (cdn.hailuoai.com/mavis-chat) and no chat request, so the reply transport is unverified; the send control is div[data-testid="send-button"] labelled in Chinese.',
  },
};
