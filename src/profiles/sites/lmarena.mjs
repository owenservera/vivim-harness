// Measured selectors for lmarena; the generic heuristic in src/capture/actions.mjs remains the fallback.
export default {
  id: 'lmarena',
  label: 'LMArena',
  hosts: ['arena.ai', 'lmarena.ai', 'www.lmarena.ai', 'chat.lmsys.org'],
  url: 'https://arena.ai/',
  composer: {
    selectors: [
      'textarea[name="message"]',
      'textarea[placeholder*="Ask anything" i]',
      'form textarea',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ],
    kind: 'auto',
  },
  send: {
    strategy: 'both',
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
      'button[data-testid="login-button"]',
      'form[action*="login"]',
    ],
    requiresAuth: true,
  },
  streamHints: {
    urlPatterns: [],
    notes: 'The probe recorded no network candidates at all on the landing view (composer empty, send button disabled), so the reply transport is unverified.',
  },
};
