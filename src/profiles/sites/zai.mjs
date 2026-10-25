// Measured selectors for zai; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'zai',
  label: 'Z.ai',
  hosts: ['chat.z.ai', 'z.ai', 'www.z.ai'],
  url: 'https://chat.z.ai/',
  composer: {
    selectors: [
      'textarea#chat-input',
      '#chat-input',
      'textarea[placeholder*="Send a Message" i]',
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
      '#send-message-button',
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
      'a[href*="/login"]',
      'a[href*="/signin"]',
      'form[action*="login"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: ['/api/v1/scene-cfg'],
    notes: 'The probe captured only GET /api/v1/scene-cfg (scene configuration, 2 calls) and no completion request, so the reply transport is unverified.',
  },
};
