// Builds the `messages` input for joinStreamToDom from a replayed StreamReducer.
// One message per response stream that has assembled text. Read-only over reducer state; no I/O.
//
// Rules (honest by construction):
//   role        'assistant' with roleSource 'inferred': a response stream carries the assistant
//               reply; user prompts live in request bodies, not in a stream.
//   key         the messageId when one was observed (from a message/response/item event), else null.
//               Never invented.
//   text        block texts in index order joined by a blank line. With no blocks, the longest
//               assembled text part. A stream with no text is skipped.
//   final       true only when the stream's terminal marker was seen.
//   blocks      [{ key, index, type, text }] for blocks that carry text; index is numeric when the
//               stream index is an integer, else the composite string (e.g. "0.1").
//   order       by the stream's first raw seq when firstSeqBySid is given, else reducer order
//               (streams are created on their first ingested record, so the two agree).

export const STREAM_MESSAGE_ROLE_SOURCE = 'inferred';

export function buildStreamMessages(reducer, { firstSeqBySid = null } = {}) {
  const rows = [];
  let pos = 0;
  for (const s of reducer.streams.values()) {
    const d = s._delta;
    if (!d || !(d.revisions > 0)) continue;
    const blocks = d.blocks().map((b) => {
      const idx = String(b.index);
      return {
        key: b.key ?? null,
        index: /^\d+$/.test(idx) ? Number(idx) : idx,
        type: typeof b.type === 'string' ? b.type : null,
        text: typeof b.text === 'string' ? b.text : null,
      };
    });
    const withText = blocks.filter((b) => b.text !== null && b.text.length > 0);
    let text;
    if (blocks.length) text = withText.map((b) => b.text).join('\n\n');
    else text = d.texts(1)[0]?.text ?? '';
    if (!text) continue;
    const seq = firstSeqBySid?.get(s.sid);
    rows.push({
      seq: Number.isFinite(seq) ? seq : Infinity, pos: pos++,
      message: {
        key: d.messageId == null ? null : String(d.messageId),
        messageId: d.messageId ?? null,
        role: 'assistant',
        roleSource: STREAM_MESSAGE_ROLE_SOURCE,
        text,
        final: s.terminalSeen === true,
        sid: s.sid,
        blocks: blocks.filter((b) => b.text !== null && b.text.length > 0).map((b) => ({ key: b.key, index: b.index, type: b.type, text: b.text })),
      },
    });
  }
  rows.sort((a, b) => (a.seq === b.seq ? a.pos - b.pos : a.seq < b.seq ? -1 : 1));
  return rows.map((r) => r.message);
}
