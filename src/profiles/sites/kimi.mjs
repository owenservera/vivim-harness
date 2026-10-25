// Measured selectors for kimi; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'kimi',
  label: 'Kimi',
  hosts: ['www.kimi.com', 'kimi.com', 'kimi.moonshot.cn'],
  url: 'https://www.kimi.com/',
  composer: {
    selectors: [
      'form div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][data-testid]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    kind: 'auto',
  },
  send: {
    strategy: 'enter',
    buttonSelectors: [
      'form button[type="submit"]',
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
    urlPatterns: ['/apiv2/kimi.gateway.chat.v1.KimiPlusService/'],
    notes: 'The probe saw only POST /apiv2/kimi.gateway.chat.v1.KimiPlusService/ListKimiPlus (a list RPC, status 200), so the chat-completion RPC and its response shape are unverified.',
  },
};
