# ChatGPT-100 live runbook — post-restart sweep, 021–100

**This runbook is a plan, not evidence.** Nothing below was executed for the sweep it describes. No objective may be marked PASS, PARTIAL or BLOCKED on the strength of a line in this file. Status changes require a command that actually ran and a result that was actually read.

Scope: objectives 021–100 of `docs/agents/CHATGPT-100-LIVE-2026-10-28.json`, classified in `docs/agents/CHATGPT-100-PROGRESS-2026-10-28.md`. Repo root `C:\0-BlackBoxProject-0\vivim-harness`, data root `C:\VIVIM`, capture browser CDP port `38702`, Studio port `38703`.

Authorization in this runbook is **read from the matrix**, not granted by this document. Every send still needs its own explicit grant.

---

## 1. Preconditions — restart proof before any objective

The serving Studio process may be stale: lane 3 edited `src/capture/*` and `src/studio/conversation-tools.mjs` while a process was already running. `GET /health` returns only `{version, apiVersion, time, recorder, events}` — no source hash — so freshness is proven by **process start time versus newest `src/**` mtime**, not by a version string. `node bin/studio.mjs version` prints `0.1.0 2d15341d95b20ea7`, which is the collector source hash, not proof of what the running process loaded.

Run from `C:\0-BlackBoxProject-0\vivim-harness`.

**1.1 Capture the tree state and dirty set before touching the process.**

```powershell
Set-Location C:\0-BlackBoxProject-0\vivim-harness
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$run = "C:\VIVIM\runbook-$stamp"
New-Item -ItemType Directory -Force $run | Out-Null
git rev-parse HEAD | Tee-Object "$run\head.txt"
git status --porcelain=v1 | Tee-Object "$run\dirty.txt"
git diff --stat | Tee-Object "$run\diffstat.txt"
Get-ChildItem C:\0-BlackBoxProject-0\vivim-harness\src -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName,LastWriteTime |
  Tee-Object "$run\newest-src.txt"
```

**1.2 Identify the listener, then stop it.** Record the old process before killing it.

```powershell
Get-NetTCPConnection -LocalPort 38703 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$_" |
    Select-Object ProcessId,CreationDate,CommandLine } |
  Tee-Object "$run\old-process.txt"
```

```powershell
Get-NetTCPConnection -LocalPort 38703 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_ -Force }
```

**1.3 Restart serving-only.** There is no stop or restart command in the CLI; `serve --studio-port <N> --no-open` runs the UI only, `start` also opens a browser.

```powershell
Start-Process -FilePath node `
  -ArgumentList 'bin/studio.mjs','serve','--studio-port','38703','--no-open','--data-dir','C:\VIVIM' `
  -WorkingDirectory 'C:\0-BlackBoxProject-0\vivim-harness' -WindowStyle Hidden
Start-Sleep -Seconds 3
node bin/studio.mjs agent status --studio-port 38703 --json
```

**1.4 Prove the process is newer than the newest source edit.**

```powershell
$p = (Get-NetTCPConnection -LocalPort 38703 -State Listen).OwningProcess | Select-Object -First 1
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
$proc | Select-Object ProcessId,CreationDate | Tee-Object "$run\new-process.txt"
$newest = (Get-ChildItem C:\0-BlackBoxProject-0\vivim-harness\src -Recurse -File |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
"newestSrc=$newest  processStarted=$($proc.CreationDate)  fresh=$($proc.CreationDate -gt $newest)" |
  Tee-Object "$run\freshness.txt"
```

`fresh=True` is the gate. `fresh=False` means the process predates the source tree: record `STALE_PROCESS`, stop the sweep, rerun 1.2–1.4. No objective result may be attributed to HEAD while the process is stale.

**1.5 Also confirm the capture browser, not just Studio.**

```powershell
node bin/studio.mjs doctor --port 38702 --json
node bin/studio.mjs targets --port 38702 --json
```

---

## 2. Execution matrix, 021–100

### 2.1 Command templates

Every command is copy-pasteable once placeholders are replaced. `--include-content` is required wherever reply text is the proof; without it the result omits private bodies.

```text
T1  capability probe (absence proof)
      node bin/studio.mjs tools list --studio-port 38703 --json
T2  target list
      node bin/studio.mjs targets --port 38702 --json
T3  conversation targets
      '{}' | node bin/studio.mjs tools call conversation_targets --input - --studio-port 38703 --json
T4  new conversation
      '{"site":"chatgpt"}' | node bin/studio.mjs tools call create_conversation --input - --studio-port 38703 --json
T5  connect to an existing thread
      '{"site":"chatgpt","targetId":"<TARGET_ID>","expectedThread":"<THREAD_URL>","freshTab":false}' | node bin/studio.mjs tools call connect_conversation --input - --studio-port 38703 --json
T6  read rendered transcript
      '{"conversation":"<CONV>","maxMessages":<N>,"maxChars":<M>}' | node bin/studio.mjs tools call read_conversation --input - --studio-port 38703 --json --include-content
T7  stored snapshot
      '{"conversation":"<CONV>"}' | node bin/studio.mjs tools call get_conversation --input - --studio-port 38703 --json --include-content
T8  rendered sidebar index
      '{"targetId":"<TARGET_ID>"}' | node bin/studio.mjs tools call chat_index --input - --studio-port 38703 --json --include-content
T9  keyed send (only with its own grant)
      '{"conversation":"<CONV>","key":"rb-20261028-<ID>","prompt":"<PROMPT>","confirm":true,"expectedRevision":<REV>}' | node bin/studio.mjs tools call submit_conversation_turn --input - --studio-port 38703 --json --timeout 60
T10 reconcile only, never resend
      '{"conversation":"<CONV>","expectedRevision":<REV>,"turnId":"<TURN_ID>"}' | node bin/studio.mjs tools call reconcile_conversation --input - --studio-port 38703 --json --timeout 60
T11 capture a URL (reloads the page once)
      node bin/studio.mjs capture <URL> --data-dir C:\VIVIM --port 38702 --json --idle 5 --timeout 120
T12 inspect the newest session
      node bin/studio.mjs session show latest --data-dir C:\VIVIM --counts --json
T13 stored summaries and turn metadata
      '{}' | node bin/studio.mjs tools call list_conversations --input - --studio-port 38703 --json
T14 finish / release the tab
      '{"conversation":"<CONV>","closeTab":false}' | node bin/studio.mjs tools call finish_conversation --input - --studio-port 38703 --json
none  do not execute: the required effect is outside the current grant
```

Tool input schemas are strict (`additionalProperties: false`). `submit_conversation_turn` = `{conversation, key, prompt, confirm:true, expectedRevision}`. `reconcile_conversation` = `{conversation, expectedRevision, turnId?}`. `read_conversation` = `{conversation, maxMessages?, maxChars?}`. `chat_index` = `{targetId, maxEntries?, maxTitleChars?, containers?}`. `connect_conversation` = `{site, targetId, expectedThread, freshTab}`.

### 2.2 Matrix

`Auth` is the first gate from the matrix. `Cmd` is the template. `Proof` is the minimum that may change a status.

| ID | Objective | Auth | Cmd | Proof that counts |
|---|---|---|---|---|
| 021 | First-turn delivery | send | T9 → T10 | Provider assistant message text answering the prompt; turn `delivery` sent, `completion` complete, non-null `finishedAt`, ≥1 `evidenceRef`. Interrupted text is not PASS. |
| 022 | Same-thread follow-up | send | T9 on 021's `<CONV>` → T10 | Second assistant reply that references the first turn; thread id unchanged across both turns. |
| 023 | Long-range continuity | send | T9 ×3, same `<CONV>` | Three delivered-and-completed turns, one constant thread id, third reply referencing turn 1. |
| 024 | Message edit / branches | missing capability | T1 | `tools list` contains no edit or branch primitive. Absence is the proof; status UNSUPPORTED. |
| 025 | Regeneration | missing capability | T1 | No regenerate primitive in the catalog. |
| 026 | Interrupt generation | send | T9 (long prompt) + T1 | A generating state observed **and** the absence of any stop primitive. Interrupt itself is unprovable without one. |
| 027 | Generation continuation | send | T9 (long prompt) + T6 | Interrupted generation observed, then no resume control in the catalog. |
| 028 | Conversation branching | missing capability | T1 | No branch-continuation primitive. |
| 029 | Conversation rename | other-effect | none | Rename is a UI mutation outside the grant. Record refusal with scope; no run. |
| 030 | Archive mutation | other-effect | none | Outside grant. |
| 031 | Multiline fidelity | send | T9 (multi-paragraph) → T6 | Stored prompt digest equals the sent body digest; reply acknowledges the paragraph count. |
| 032 | Unicode editing | send | T9 (accents, emoji, RTL) → T6 | Rendered reply re-reads the same code points; record digest. |
| 033 | Keyboard send | send | T9 | `delivery` recorded as sent, reply completed. |
| 034 | Keyboard newline | send | T9 (multiline body) | Newline preserved in the delivered body. There is no newline-without-submit primitive — if that separation is the requirement, record HARNESS_UNSUPPORTED, not PARTIAL. |
| 035 | Model selection | missing capability | T1 | No model-picker primitive. |
| 036 | Temporary Chat | missing capability | T1 | No Temporary Chat primitive. |
| 037 | Speech input | missing capability | T1 | No microphone or audio primitive. |
| 038 | Suggestion chip | missing capability | T1 | No click primitive. |
| 039 | Copy action | missing capability | T1 | No clipboard-read primitive. |
| 040 | Feedback UI | missing capability | T1 | No click or control-inventory primitive. |
| 041 | Long-answer extraction | send | T9 → T6 | Reply spanning multiple screens; `read_conversation` returns bounded text with a coverage note. |
| 042 | Role attribution | send | T9 → T6 | Alternating user/assistant roles preserved in the transcript. |
| 043 | List structure | send | T9 → T6 | Nested list markers preserved. |
| 044 | Code block fidelity | send | T9 → T6 | Fenced block boundaries and language preserved. |
| 045 | Table semantics | send | T9 → T6 | Row and column structure preserved. |
| 046 | Math fidelity | send | T9 → T6 | Rendered math markers preserved. |
| 047 | Quotation structure | send | T9 → T6 | Blockquote boundaries preserved. |
| 048 | Hyperlink extraction | send | T9 → T6 | `href` values present in the transcript. |
| 049 | Citation anchoring | send | T9 → T6 | Citation markers plus their targets. |
| 050 | Image-block extraction | send | T9 → T6 | Image element with alt text in the transcript. |
| 051 | Search-tool activation | send | T9 → T6 | Search ran: turn journal shows the action, reply shows the result. |
| 052 | Source cards | send | T9 → T6 | Source card list rendered in the reply. |
| 053 | Citation-source navigation | other-effect | none | Click-through of the source UI is outside the grant. |
| 054 | Tool-panel expansion | missing capability | T1 | No expand or click primitive. |
| 055 | Evidence presence | send | T9 ×2 → T6 | One sourced and one unsourced answer, compared. |
| 056 | Reasoning mode awareness | missing capability | T1 | No mode selector. |
| 057 | Reasoning completion | send | T9 → T6 | Long reasoning answer with a terminal completion state. |
| 058 | Deep Research discovery | navigation | T11 `https://chatgpt.com/` → T12 | Captured page contains the Deep Research entry point. Do not start a run. |
| 059 | Research job monitoring | navigation | T11 on an existing `/c/<uuid>` | Rendered research task state read; no new job. |
| 060 | Research report navigation | navigation | T11 on the report `/c/<uuid>` | Report sections and reference links present in the capture. |
| 061 | File-picker input | other-effect | none | Upload outside grant. |
| 062 | Vision-file submission | other-effect | none | Upload outside grant. |
| 063 | PDF interpretation | other-effect | none | Upload outside grant. |
| 064 | Tabular file analysis | other-effect | none | Upload outside grant. |
| 065 | Spreadsheet rendering | other-effect | none | Upload outside grant. |
| 066 | Source-file input | other-effect | none | Upload outside grant. |
| 067 | File download | other-effect | none | Download outside grant. |
| 068 | Attachment preview | other-effect | none | Needs an attachment first; upload outside grant. |
| 069 | Image generation result | send | T9 (image prompt) → T6 | Image block present in the reply. |
| 070 | Upload failure detection | other-effect | none | Upload outside grant. |
| 071 | Generated-document controls | send | T9 → T6 | Generated attachment control present in the reply. |
| 072 | Writing-artifact surface | send | T9 → T6 | Canvas or artifact surface rendered. |
| 073 | Artifact edit | missing capability | T1 | No artifact-edit primitive. |
| 074 | Data-analysis provenance | send | T9 → T6 | Execution provenance block rendered in the reply. |
| 075 | Tool failure detection | send | T9 (deliberately failing tool prompt) → T6 | Error surface text recorded verbatim. |
| 076 | Diagram artifact | send | T9 → T6 | Diagram artifact rendered. |
| 077 | Chart semantics | send | T9 → T6 | Chart artifact rendered with readable labels. |
| 078 | Input-output provenance | send | T9 → T6 | Provenance block present. |
| 079 | Code copying | send | T9 → T6 | Code block rendered plus copy control present. Clipboard read is unavailable: PARTIAL is the ceiling. |
| 080 | Artifact-open navigation | send | T9 → T6 | Generated attachment present and openable in the reply. |
| 081 | Project creation | other-effect | none | Creation outside grant. |
| 082 | Conversation-to-Project move | other-effect | none | Outside grant. |
| 083 | Project unlink | other-effect | none | Outside grant. |
| 084 | Project instructions read | navigation | T11 on the project URL → T12 | Project instructions text in the capture. URL shape must be read off the rendered sidebar first; there is no click primitive. |
| 085 | Project file attachment | other-effect | none | Upload outside grant. |
| 086 | Project-specific history | navigation | T11 on the project URL → T12 | Project thread list rendered in the capture. |
| 087 | Sharing control discovery | missing capability | T1 | No share-control reader; publishing is excluded regardless. |
| 088 | Share-link revocation | other-effect | none | Destructive; needs its own grant. |
| 089 | Memory setting inspection | navigation | T11 `https://chatgpt.com/` → T12 | Settings panel text in the capture. Without a click primitive only a direct settings URL can reach it; if none renders, record HARNESS_UNSUPPORTED, not PASS. |
| 090 | Personalization discovery | navigation | T11 `https://chatgpt.com/` → T12 | Same constraint as 089. |
| 091 | Network loss detection | other-effect | none | Offline manipulation outside grant. |
| 092 | Session expiration | sign-in | none | Needs a real expiry or a human sign-out/sign-in cycle. Human step, not an agent command. |
| 093 | Target drift | send | T9 then T2 during generation → T7 | Target id before and after differ, and the journal records the drift. |
| 094 | Snapshot freshness | navigation | T11 ×2 on the same `/c/<uuid>` → T12 | Two captures compared: second content differs or carries a later fetch marker. |
| 095 | Runtime reconnection | other-effect | none, observed from §1.4 | Journal recovery across the restart may be recorded as an observation. That does not satisfy the full objective: no PASS without a deliberately dropped CLI request. |
| 096 | No-resend reconciliation | send | T9 (forces a timeout) → T10 same key | Reconcile resolves to exactly one turn; no duplicate in the thread. |
| 097 | Rate-limit detection | other-effect | none | Needs a real quota condition; outside grant. |
| 098 | Timeout truthfulness | send | T9 (slow prompt) → T10 | `timedOut` and `finishedAt` reflect what happened; a slow reply is distinguished from a failed one. |
| 099 | Capture provenance | navigation | T11 on a completed thread → T12 | Session shows `collectorSourceSha` and `integrityOk true`. |
| 100 | Return-to-source continuity | navigation | T12 → T11 on the native `/c/<uuid>` | Local transcript compared against the native URL thread. |

Counts: send 36 · other-effect 20 · missing capability 13 · navigation 10 · sign-in 1 = 80.

---

## 3. Send protocol

**3.1 One durable key per objective.** Format `rb-20261028-<ID>`, e.g. `rb-20261028-021`. Keys are caller-owned and never regenerated. A key is bound to one objective and one payload.

**3.2 `expectedRevision` comes from the record, never invented.** Take `revision` from the `create_conversation` or `get_conversation` result immediately before the send. A `409` revision mismatch means re-read (T7) and retry once with the fresh revision **only if the prompt body is byte-identical**; a changed body is a new objective and a new key.

**3.3 Timeout is never failure and never permission to resend.** On an HTTP timeout or an unknown delivery result:

1. Do not call T9 again, with the same key or a new one.
2. Call T10 with the same `conversation`, the same `expectedRevision`, and `turnId` if the turn id is known.
3. Record both results. If reconcile resolves a delivered, completed turn, that is the evidence. If it does not resolve, the attempt is PARTIAL with `timedOut: true` and `evidenceGap: true`.

**3.4 Exact send and reconcile commands with placeholders.**

```powershell
# T9 — one authorized send, one key, one payload
'{"conversation":"<CONV>","key":"rb-20261028-<ID>","prompt":"<PROMPT>","confirm":true,"expectedRevision":<REV>}' | node bin/studio.mjs tools call submit_conversation_turn --input - --studio-port 38703 --json --timeout 60
```

```powershell
# T10 — reconcile only
'{"conversation":"<CONV>","expectedRevision":<REV>,"turnId":"<TURN_ID>"}' | node bin/studio.mjs tools call reconcile_conversation --input - --studio-port 38703 --json --timeout 60
```

**3.5 Record per send, before anything else:** objective id, key, `expectedRevision`, HTTP status, tool result JSON, reconcile result, and whether the reply text was actually read with `--include-content`.

**3.6 The one-send routes `chat --execute --accept-sends` and `drive` create no durable key.** They are not used in this sweep. Keyed `submit_conversation_turn` is the only send route here.

---

## 4. Failure taxonomy and what to record

No failure condition ever maps to PASS.

| Condition | Status | Record |
|---|---|---|
| `TIMEOUT` | PARTIAL | `timedOut: true`, `finishedAt` as observed, reconcile result, `failureClassification: "TIMEOUT"`. Never a resend. |
| `AUTH_WALL` | BLOCKED | Login wall text or redirect observed; `failureClassification: "AUTH_WALL"`; sign-in is the human's step. |
| `HARNESS_UNSUPPORTED` | UNSUPPORTED | The `tools list` output showing the missing primitive, plus the objective it blocks. |
| `TARGET_SITE_MISMATCH` | BLOCKED | Expected origin versus observed origin/target id; `failureClassification: "TARGET_SITE_MISMATCH"`. |
| `BINDING_CHANGED` | PARTIAL at best | `readiness.reason` verbatim plus the target id that changed. Never PASS. |
| `PROVIDER_ERROR` | BLOCKED | Provider error text verbatim; no inference about what it means. |
| `STALE_PROCESS` | no status change | `freshness.txt` showing `fresh=False`. Stop the sweep. |

Every attempt records `authorizationScope`, the exact command, and the result. An attempt with no command and no result is not an attempt.

---

## 5. Do-not-rerun

| Objective | Why | Rerun only if |
|---|---|---|
| 011 | PASS. Blank chat opened, 0 turns, nothing sent, no message. Re-running proves nothing new. | A new-conversation route appears, or the `BINDING_CHANGED` readiness reason must be re-read — and then under 006, not 011. |
| 013 | PASS. Exact `/c/` thread rendered, title `TOOLSMITH`, 521 records, `integrityOk true`. | The capture route changes, or the artifact on disk is deleted and its evidence must be re-established. |
| 012 | PARTIAL caused by `chat_index` returning empty `displayTitle`. A rerun reproduces the same gap. | The title-extraction fix lands and `tools list` still exposes `chat_index`. |
| 024, 025, 028 | UNSUPPORTED on a proven absent primitive. | `tools list` gains an edit, regenerate or branch tool. |
| 002, 005 | Statuses stand; both attempts are annotated `evidenceGap: true`. | A fresh attempt with a real time budget and a non-null `finishedAt` is scheduled for 002. 005 is superseded by `ERA2_RETEST_2`. |

The capture artifact `C:\VIVIM\sessions\20261028-115823-chatgpt-com-04a400` is the evidence behind 013. Do not delete it while 013 stands at PASS.

---

## 6. Stop conditions

Stop the sweep immediately, record the condition, and do not continue to the next objective when any of these is true:

1. **Sign-in required** — a login wall, a signed-out composer, or a redirect to an auth page.
2. **Unowned target** — a tab the Studio does not own, or `ownedByStudio` false where ownership is asserted.
3. **Readiness not ready** — `readiness.ready: false`, including `BINDING_CHANGED`.
4. **Active generation** — a reply still streaming in the bound thread.
5. **Unsafe draft** — non-empty composer content the run did not author.
6. **Any send without an explicit grant** — no key, no `confirm: true`, no `expectedRevision`, or no grant for that objective id.
7. **Stale process** — `fresh=False` from §1.4.
8. **Ledger divergence** — a status change that no command result supports.

---

## 7. Rollback — leaving the ledger consistent after an interruption

**7.1 Snapshot both ledgers before the first objective.**

```powershell
Copy-Item C:\0-BlackBoxProject-0\vivim-harness\docs\agents\CHATGPT-100-LIVE-2026-10-28.json "$run\live.pre.json"
Copy-Item C:\0-BlackBoxProject-0\vivim-harness\docs\agents\CHATGPT-100-INVESTIGATION-2026-10-28.json "$run\inv.pre.json"
```

**7.2 Interrupted mid-objective, before any send.** Close the attempt honestly: set `finishedAt` to the observed stop time, `timedOut` to the truth, `failureClassification` to the taxonomy value, and leave the objective status unchanged. An attempt that never produced a result is recorded as an attempt with no status claim, not deleted.

**7.3 Interrupted after a send, delivery unknown.** Reconcile with the original key and `expectedRevision` (T10). If reconcile cannot resolve, the attempt is PARTIAL with `timedOut: true` and `evidenceGap: true`. The key is retired, not replaced.

**7.4 Ledger write itself interrupted.** The live ledger is hand-edited with inline arrays and is **not** `JSON.stringify(…, 2)` output, so never rewrite it wholesale. Restore the pre-sweep copy and re-apply only the verified attempts:

```powershell
Copy-Item "$run\live.pre.json" C:\0-BlackBoxProject-0\vivim-harness\docs\agents\CHATGPT-100-LIVE-2026-10-28.json -Force
```

**7.5 Validate after every recovery, before continuing.**

```powershell
node -e "const fs=require('fs');for(const p of ['docs/agents/CHATGPT-100-LIVE-2026-10-28.json','docs/agents/CHATGPT-100-INVESTIGATION-2026-10-28.json']){const j=JSON.parse(fs.readFileSync(p,'utf8'));const o=j.objectives||[];const n=o.reduce((a,x)=>a+(x.attempts||[]).length,0);console.log(p.split('/').pop(),'parse=ok','objectives='+o.length,'attempts='+n);}"
```

Gate: both files parse, objectives `100`, and the status histogram matches the matrix (PASS 2 · PARTIAL 6 · BLOCKED 3 · UNSUPPORTED 18 · NOT_TESTED 71) plus whatever this sweep legitimately changed. A histogram that moved without a matching command result is a rollback trigger.
