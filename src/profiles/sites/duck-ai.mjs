// Measured selectors for Duck.ai (DuckDuckGo's guest AI chat), taken from a live guest session
// on 2026-10-24 in the sandbox capture browser (Chrome for Testing 143, headless, loopback CDP):
//   - composer is <form><textarea aria-label="Reply to Duck.ai" placeholder="Reply..."></textarea></form>;
//     on a fresh chat the aria-label is "Ask anything privately" (same textarea element).
//   - the send control is a real submit button inside that form (aria-label "Send", disabled until
//     the composer has text); a "Stop generating" button sits next to it while a reply streams.
//   - the user turn renders as div[data-testid="user-message"] with an h3 "You said" heading.
//   - after the first dispatch the URL gains ?chatID=<uuid> (query-parameter thread identity).
// The assistant turn container was never rendered in that probe (the chat API answered
// "Duck.ai is temporarily unavailable" with an anonymous code for a datacenter IP), so no
// assistant test id is asserted here — the generic heuristic in src/capture/actions.mjs and the
// candidates below are the fallback, and streamHints.notes records the unverified transport.
export default {
  id: 'duck-ai',
  label: 'Duck.ai',
  hosts: ['duck.ai'],
  url: 'https://duck.ai/',
  composer: {
    selectors: [
      'form textarea[aria-label*="Duck.ai" i]',
      'form textarea[aria-label*="Ask anything" i]',
      'form textarea[placeholder*="Reply" i]',
      '[data-testid="duckai-chat-input"] textarea',
      'form textarea',
      'textarea[aria-label*="Duck.ai" i]',
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
      'button[aria-label="Send"]',
      'button[type="submit"]',
    ],
  },
  assistant: {
    containerSelectors: [
      'div[class*="markdown"]',
      'div[class*="prose"]',
      'article',
      '[data-testid*="assistant" i]',
    ],
    streamingSelectors: [
      'button[aria-label="Stop generating"]',
      'button[aria-label*="stop" i]',
      '[aria-busy="true"]',
    ],
    doneWhen: 'text-stable',
  },
  preflight: {
    // Guest chat works without an account: the composer accepts text and the first message
    // dispatches (observed twice). No login wall was shown.
    authWallSelectors: [],
    requiresAuth: false,
  },
  streamHints: {
    urlPatterns: [],
    notes: [
      'Live probe 2026-10-24 (guest, no account): composer verified, first message dispatched twice; the chat API answered "Duck.ai is temporarily unavailable" (anonymous error code shown inline) for a datacenter IP, so the reply transport is unverified.',
      'Second live probe 2026-10-24, later run (guest, fresh profile): the first dispatch landed — the user turn rendered ("You said" + prompt), the URL gained ?chatID=<uuid>, and the provider again refused generation with the same "temporarily unavailable" + anonymous code 02f8; the composer then stayed disabled until reload. The dispatch itself is therefore proven; the refusal is provider-side.',
      'First-use privacy consent: a "We don\'t track you..." region with a Continue button appears before the first reply and must be accepted once before streaming starts.',
      'Thread identity: after the first dispatch the URL gains ?chatID=<uuid>; the thread key is the chatID query parameter, not a path segment. Guest chats are listed in a browser-local "Your recent chats" region; no durable cross-device identity was claimed or observed.',
      'DOM turn shape: the user turn is div[data-testid="user-message"] containing an h3 "You said" heading plus the prompt text; the generic L3 role scan does not recognize test-id-prefixed roles, so DOM_TURNS stays empty on this site and acceptance G1/G2 honestly abstain rather than fabricate turns.',
    ].join(' '),
  },
};
