# AI chat shape library

> **Generated output - do not edit by hand.** Regenerate with the command below.
>
> - command: `node scripts/ai-chat-report.mjs`
> - data dir: `C:\Users\VIVIM.inc\AppData\Local\AION\capture-studio`
> - generated (UTC): `2026-10-22T01:47:20Z`
> - families with a chat surface: 8
>
> Every value is read from a captured family file (`families/<familyId>/vNNNN.json`).
> Fields that the captures do not show are printed as "not observed".
>
> A family counts as an AI-chat family when its id/hosts match a site adapter host
> (`src/profiles/sites/index.mjs` -> `ADAPTER_IDS`), or when it exposes at least two
> endpoints matching `/conversation|completion|chat|message|generate|stream|reply|timeline|response/i`.

## Summary

| family | hosts | sessions | derived | streams | transports | chat endpoints | endpoints (total) | signature |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| agent.minimax.cn | agent.minimax.cn | 5 | 5 | 1 | HTTP | 0 | 1 | sha256:374f31c25b39d751 |
| chat.deepseek.com | chat.deepseek.com | 5 | 5 | 8 | HTTP, HTTP_SSE, HTTP_STREAMED | 4 | 8 | sha256:52bf073c6999a88d |
| chat.qwen.ai | chat.qwen.ai | 3 | 3 | 4 | HTTP | 0 | 4 | sha256:a56cd70e322f6f6b |
| chat.z.ai | chat.z.ai | 14 | 14 | 5 | HTTP, HTTP_STREAMED, WEBSOCKET | 2 | 5 | sha256:88d1ba8d444689fa |
| chatgpt.com | chatgpt.com | 26 | 26 | 47 | HTTP, HTTP_SSE, HTTP_STREAMED, UNKNOWN, WEBSOCKET | 9 | 47 | sha256:d84056d13869c74d |
| claude.ai | claude.ai | 11 | 11 | 31 | EVENT_SOURCE, HTTP, HTTP_STREAMED | 3 | 31 | sha256:6d98bc713c733370 |
| gemini.google.com | gemini.google.com | 7 | 7 | 10 | HTTP, HTTP_STREAMED, WEBSOCKET | 1 | 10 | sha256:8fdf75458f41c8ed |
| www.kimi.com | www.kimi.com | 4 | 4 | 12 | HTTP | 1 | 12 | sha256:2bc427ceede101b0 |

## agent.minimax.cn

- hosts: `agent.minimax.cn`
- site / family name: `minimax.cn` / `agent.minimax.cn`
- member sessions: 5 (`20261022-014412-minimax-a45762`, `20261022-010117-minimax-401f94`, `20261022-005653-minimax-4f8163`, `20261022-004617-minimax-2b9c3f`, `20261021-234249-minimax-f8126a`)
- derived sessions: 5, streams: 1
- transports: `HTTP`
- profile / signature: not observed / `sha256:374f31c25b39d751`
- endpoint surface: 0 chat, 1 total

No chat endpoint was observed in this family.

## chat.deepseek.com

- hosts: `chat.deepseek.com`
- site / family name: `deepseek.com` / `chat.deepseek.com`
- member sessions: 5 (`20261022-014148-deepseek-3d5251`, `20261022-011405-deepseek-cfa4e5`, `20261022-004155-deepseek-b7d861`, `20261021-234539-deepseek-925f6e`, `20261021-233421-deepseek-a23d7a`)
- derived sessions: 5, streams: 8
- transports: `HTTP`, `HTTP_SSE`, `HTTP_STREAMED`
- profile / signature: not observed / `sha256:52bf073c6999a88d`
- endpoint surface: 4 chat, 8 total

| transport | endpoint | field paths | delta / content field paths |
| --- | --- | --- | --- |
| HTTP | `/api/v0/chat_session/create` | 21 | `$.data.biz_data.chat_session.current_message_id`, `$.data.biz_msg`, `$.msg` |
| HTTP_SSE | `/api/v0/chat/completion` | 46 | `$.content`, `$.request_message_id`, `$.response_message_id`, `$.v.response` (+27 more) |
| HTTP | `/api/v0/chat/create_pow_challenge` | 16 | `$.data.biz_msg`, `$.msg` |
| HTTP_STREAMED | `/chat/static/8138.63461459c3.js` | 1 | not observed |

<details><summary>All delta / content field paths</summary>

**`/api/v0/chat/completion`** (HTTP_SSE)

```
$.content
$.request_message_id
$.response_message_id
$.v.response
$.v.response.accumulated_token_usage
$.v.response.auto_continue
$.v.response.ban_edit
$.v.response.ban_regenerate
$.v.response.conversation_mode
$.v.response.extra_search_providers
$.v.response.feedback
$.v.response.fragments
$.v.response.fragments[*]
$.v.response.fragments[*].content
$.v.response.fragments[*].elapsed_secs
$.v.response.fragments[*].id
$.v.response.fragments[*].references
$.v.response.fragments[*].stage_id
$.v.response.fragments[*].type
$.v.response.has_pending_fragment
$.v.response.incomplete_message
$.v.response.inserted_at
$.v.response.message_id
$.v.response.model
$.v.response.parent_id
$.v.response.role
$.v.response.search_enabled
$.v.response.search_triggered
$.v.response.status
$.v.response.thinking_enabled
$.v[*].content
```

</details>

## chat.qwen.ai

- hosts: `chat.qwen.ai`
- site / family name: `qwen.ai` / `chat.qwen.ai`
- member sessions: 3 (`20261021-235124-qwen-bf8088`, `20261021-234634-qwen-46ca2a`, `20261021-234002-qwen-ddb4da`)
- derived sessions: 3, streams: 4
- transports: `HTTP`
- profile / signature: not observed / `sha256:a56cd70e322f6f6b`
- endpoint surface: 0 chat, 4 total

No chat endpoint was observed in this family.

## chat.z.ai

- hosts: `chat.z.ai`
- site / family name: `z.ai` / `chat.z.ai`
- member sessions: 14 (`20261022-014259-zai-52ebd7`, `20261022-013326-zai-fb542c`, `20261022-012945-zai-11bb10`, `20261022-012607-zai-e1aa8d`, `20261022-012337-zai-9cc377`, `20261022-011908-chat-z-ai-e7fe86`, `20261022-011855-zai-7db7c3`, `20261022-011253-zai-67d657`, `20261022-010901-zai-cf4447`, `20261022-010227-zai-2cd3f3`, `20261022-010004-zai-dc6fdf`, `20261022-005534-zai-bcb114`, `20261022-004255-zai-92b03c`, `20261021-233811-zai-a9e8a8`)
- derived sessions: 14, streams: 5
- transports: `HTTP`, `HTTP_STREAMED`, `WEBSOCKET`
- profile / signature: not observed / `sha256:88d1ba8d444689fa`
- endpoint surface: 2 chat, 5 total

| transport | endpoint | field paths | delta / content field paths |
| --- | --- | --- | --- |
| HTTP_STREAMED | `/api/v1/chats/` | 17 | not observed |
| HTTP | `/api/v1/chats/new` | 162 | `$.chat.history.messages`, `$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"]`, `$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].childrenIds`, `$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].content` (+115 more) |

<details><summary>All delta / content field paths</summary>

**`/api/v1/chats/new`** (HTTP)

```
$.chat.history.messages
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"]
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].childrenIds
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].content
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].id
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].models
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].models[*]
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].parentId
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].role
$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].timestamp
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"]
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].childrenIds
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].content
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].id
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].models
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].models[*]
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].parentId
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].role
$.chat.history.messages["54979e59-48a2-4b43-b0c7-188516b9cd46"].timestamp
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"]
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].childrenIds
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].content
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].id
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].models
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].models[*]
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].parentId
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].role
$.chat.history.messages["5b2b37db-58f8-41a9-a38a-c0259da39f60"].timestamp
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"]
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].childrenIds
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].content
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].id
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].models
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].models[*]
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].parentId
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].role
$.chat.history.messages["61a1a639-8c93-4744-8a6f-464f2ad15d20"].timestamp
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"]
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].childrenIds
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].content
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].id
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].models
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].models[*]
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].parentId
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].role
$.chat.history.messages["76cf5378-877c-4bc0-9ba5-608ae3fbf8c8"].timestamp
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"]
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].childrenIds
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].content
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].id
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].models
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].models[*]
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].parentId
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].role
$.chat.history.messages["95317aaa-087e-439c-9857-2afbe6ff1052"].timestamp
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"]
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].childrenIds
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].content
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].id
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].models
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].models[*]
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].parentId
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].role
$.chat.history.messages["aff0422a-3008-4b26-9c7a-50faae30ad2d"].timestamp
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"]
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].childrenIds
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].content
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].id
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].models
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].models[*]
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].parentId
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].role
$.chat.history.messages["b204b0ee-ea27-4d2b-9016-df75a4c3477e"].timestamp
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"]
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].childrenIds
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].content
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].id
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].models
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].models[*]
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].parentId
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].role
$.chat.history.messages["bd877eeb-8caa-46d3-b380-de975f9b671c"].timestamp
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"]
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].childrenIds
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].content
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].id
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].models
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].models[*]
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].parentId
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].role
$.chat.history.messages["c01fc938-f1a8-443d-9c9e-fb0cf8468dba"].timestamp
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"]
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].childrenIds
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].content
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].id
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].models
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].models[*]
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].parentId
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].role
$.chat.history.messages["c387b46f-f3ce-4d14-b7eb-36e2e094f1f8"].timestamp
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"]
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].childrenIds
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].content
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].id
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].models
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].models[*]
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].parentId
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].role
$.chat.history.messages["d5464694-2ab0-45fe-86f9-6b28520d1538"].timestamp
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"]
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].childrenIds
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].content
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].id
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].models
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].models[*]
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].parentId
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].role
$.chat.history.messages["deabb133-7e93-4389-a9bc-7d72ef2ed334"].timestamp
$.message_version
```

</details>

## chatgpt.com

- hosts: `chatgpt.com`
- site / family name: `chatgpt.com` / `chatgpt.com`
- member sessions: 26 (`20261022-013418-chatgpt-4d356a`, `20261022-013153-chatgpt-d2ada9`, `20261022-012849-chatgpt-1d0e9b`, `20261022-012511-chatgpt-54ad2b`, `20261022-012244-chatgpt-16639a`, `20261022-012015-chatgpt-com-b1bcb7`, `20261022-011659-chatgpt-com-cc3796`, `20261022-011644-chatgpt-03e479`, `20261022-011038-chatgpt-0698dd`, `20261022-010601-chatgpt-1f85ef`, `20261022-010305-chatgpt-000d39`, `20261022-003500-chatgpt-1cab77`, `20261022-003352-chatgpt-4695c1`, `20261022-001957-chatgpt-b7d86d`, `20261022-001745-chatgpt-1c3e61`, `20261022-001539-chatgpt-4ae32a`, `20261022-001327-chatgpt-985861`, `20261022-000302-chatgpt-e2ce05`, `20261022-000020-chatgpt-779d09`, `20261021-235644-chatgpt-da3251`, `20261021-232952-chatgpt-c77c83`, `20261021-232612-chatgpt-46d30e`, `20261021-231402-chatgpt-com-30f1d8`, `20261021-222313-chatgpt-66ce56`, `20261021-221801-chatgpt-c158af`, `20261021-221453-chatgpt-ac817b`)
- derived sessions: 26, streams: 47
- transports: `HTTP`, `HTTP_SSE`, `HTTP_STREAMED`, `UNKNOWN`, `WEBSOCKET`
- profile / signature: not observed / `sha256:d84056d13869c74d`
- endpoint surface: 9 chat, 47 total

| transport | endpoint | field paths | delta / content field paths |
| --- | --- | --- | --- |
| HTTP | `/backend-api/conversation/init` | 13 | not observed |
| HTTP | `/backend-api/conversations` | 42 | not observed |
| HTTP | `/backend-api/conversations/{id}` | 178 | `$.messages`, `$.messages[*]`, `$.messages[*].author`, `$.messages[*].author.metadata` (+135 more) |
| HTTP_SSE | `/backend-api/f/conversation` | 296 | `$.entry.payload`, `$.entry.payload.options`, `$.entry.payload.options[*]`, `$.entry.payload.options[*].id` (+185 more) |
| HTTP | `/backend-api/f/conversation/prepare` | 3 | `$.conduit_token` |
| HTTP | `/backend-api/sentinel/chat-requirements/finalize` | 5 | `$.token` |
| HTTP | `/backend-api/sentinel/chat-requirements/prepare` | 14 | `$.prepare_token` |
| HTTP_STREAMED | `/backend-api/sentinel/chat-requirements/prepare` | 14 | `$.prepare_token` |
| HTTP | `/backend-api/user_system_messages` | 18 | `$.about_model_message`, `$.about_user_message`, `$.name_user_message`, `$.other_user_message` (+2 more) |

<details><summary>All delta / content field paths</summary>

**`/backend-api/conversations/{id}`** (HTTP)

```
$.messages
$.messages[*]
$.messages[*].author
$.messages[*].author.metadata
$.messages[*].author.metadata.real_author
$.messages[*].author.name
$.messages[*].author.role
$.messages[*].channel
$.messages[*].content
$.messages[*].content.content
$.messages[*].content.content_type
$.messages[*].content.parts
$.messages[*].content.parts[*]
$.messages[*].content.source_analysis_msg_id
$.messages[*].content.thoughts
$.messages[*].content.thoughts[*]
$.messages[*].content.thoughts[*].chunks
$.messages[*].content.thoughts[*].content
$.messages[*].content.thoughts[*].finished
$.messages[*].content.thoughts[*].summary
$.messages[*].create_time
$.messages[*].end_turn
$.messages[*].id
$.messages[*].metadata
$.messages[*].metadata.can_save
$.messages[*].metadata.citations
$.messages[*].metadata.content_references
$.messages[*].metadata.continuation_message_id
$.messages[*].metadata.conversation_followup_suggestions_eligible
$.messages[*].metadata.cot_version
$.messages[*].metadata.debug_sonic_thread_id
$.messages[*].metadata.default_model_slug
$.messages[*].metadata.disable_turn_actions
$.messages[*].metadata.exclusive_key
$.messages[*].metadata.finish_details
$.messages[*].metadata.finish_details.stop_tokens
$.messages[*].metadata.finish_details.stop_tokens[*]
$.messages[*].metadata.finish_details.type
$.messages[*].metadata.finished_duration_sec
$.messages[*].metadata.hide_inline_actions
$.messages[*].metadata.inline_cot_expandable_content
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*]
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].domain
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*]
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].attribution
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].pub_date
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id.ref_index
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id.ref_type
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id.turn_index
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].snippet
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].title
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].type
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].url
$.messages[*].metadata.inline_cot_expandable_content.search_result_groups[*].type
$.messages[*].metadata.inline_cot_expandable_content.source_message_ids
$.messages[*].metadata.inline_cot_expandable_content.source_message_ids[*]
$.messages[*].metadata.is_complete
$.messages[*].metadata.is_merged_message
$.messages[*].metadata.is_visually_hidden_from_conversation
$.messages[*].metadata.logical_answer_prefix_activity
$.messages[*].metadata.logical_answer_prefix_activity.visibility
$.messages[*].metadata.message_source
$.messages[*].metadata.message_type
$.messages[*].metadata.model_dil_v2
$.messages[*].metadata.model_dil_v2.appData
$.messages[*].metadata.model_dil_v2.appData.opGenui
$.messages[*].metadata.model_dil_v2.appData.opGenui.componentResults
$.messages[*].metadata.model_dil_v2.appData.opGenui.interactionSurface
$.messages[*].metadata.model_dil_v2.appData.opGenui.modelDataBindings
$.messages[*].metadata.model_dil_v2.code
$.messages[*].metadata.model_dil_v2.constants
$.messages[*].metadata.model_dil_v2.constants["0"]
$.messages[*].metadata.model_dil_v2.fallbackMarkdown
$.messages[*].metadata.model_dil_v2.fallbackMarkdownVersion
$.messages[*].metadata.model_slug
$.messages[*].metadata.model_switcher_deny
$.messages[*].metadata.parent_id
$.messages[*].metadata.reasoning_end_time
$.messages[*].metadata.reasoning_group_id
$.messages[*].metadata.reasoning_recap_type
$.messages[*].metadata.reasoning_start_time
$.messages[*].metadata.reasoning_status
$.messages[*].metadata.reasoning_title
$.messages[*].metadata.reasoning_title_content_transition
$.messages[*].metadata.reasoning_titles
$.messages[*].metadata.reasoning_titles[*]
$.messages[*].metadata.rebase_developer_message
$.messages[*].metadata.request_id
$.messages[*].metadata.resolved_model_slug
$.messages[*].metadata.safe_urls
$.messages[*].metadata.safe_urls[*]
$.messages[*].metadata.search_model_queries
$.messages[*].metadata.search_model_queries.queries
$.messages[*].metadata.search_model_queries.queries[*]
$.messages[*].metadata.search_model_queries.type
$.messages[*].metadata.search_result_groups
$.messages[*].metadata.search_result_groups[*]
$.messages[*].metadata.search_result_groups[*].domain
$.messages[*].metadata.search_result_groups[*].entries
$.messages[*].metadata.search_result_groups[*].entries[*]
$.messages[*].metadata.search_result_groups[*].entries[*].attribution
$.messages[*].metadata.search_result_groups[*].entries[*].pub_date
$.messages[*].metadata.search_result_groups[*].entries[*].ref_id
$.messages[*].metadata.search_result_groups[*].entries[*].ref_id.ref_index
$.messages[*].metadata.search_result_groups[*].entries[*].ref_id.ref_type
$.messages[*].metadata.search_result_groups[*].entries[*].ref_id.turn_index
$.messages[*].metadata.search_result_groups[*].entries[*].snippet
$.messages[*].metadata.search_result_groups[*].entries[*].title
$.messages[*].metadata.search_result_groups[*].entries[*].type
$.messages[*].metadata.search_result_groups[*].entries[*].url
$.messages[*].metadata.search_result_groups[*].type
$.messages[*].metadata.source_message_ids
$.messages[*].metadata.source_message_ids[*]
$.messages[*].metadata.tool_icons
$.messages[*].metadata.tool_icons[*]
$.messages[*].metadata.tool_summary_type
$.messages[*].metadata.turn_exchange_id
$.messages[*].metadata.user_signal_metadata
$.messages[*].metadata.user_signal_metadata.conversation_rating
$.messages[*].metadata.user_signal_metadata.conversation_rating.name
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.options
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.options[*]
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.options[*].id
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.options[*].label
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.prompt
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.question
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.shown_at_assistant_turn
$.messages[*].metadata.user_signal_metadata.conversation_rating.payload.type
$.messages[*].metadata.user_signal_metadata.conversation_rating.version
$.messages[*].metadata.view_state
$.messages[*].metadata.working_turn_id
$.messages[*].recipient
$.messages[*].status
$.messages[*].update_time
$.messages[*].weight
```

**`/backend-api/f/conversation`** (HTTP_SSE)

```
$.entry.payload
$.entry.payload.options
$.entry.payload.options[*]
$.entry.payload.options[*].id
$.entry.payload.options[*].label
$.entry.payload.prompt
$.entry.payload.question
$.entry.payload.shown_at_assistant_turn
$.entry.payload.type
$.input_message
$.input_message.author
$.input_message.author.metadata
$.input_message.author.name
$.input_message.author.role
$.input_message.channel
$.input_message.content
$.input_message.content.content_type
$.input_message.content.parts
$.input_message.content.parts[*]
$.input_message.create_time
$.input_message.end_turn
$.input_message.id
$.input_message.metadata
$.input_message.metadata.message_source
$.input_message.metadata.parent_id
$.input_message.metadata.request_id
$.input_message.metadata.turn_exchange_id
$.input_message.metadata.working_turn_id
$.input_message.recipient
$.input_message.status
$.input_message.update_time
$.input_message.weight
$.message_id
$.metadata.message_id
$.token
$.updates[*].message_id
$.v.message
$.v.message.author
$.v.message.author.metadata
$.v.message.author.metadata.real_author
$.v.message.author.name
$.v.message.author.role
$.v.message.channel
$.v.message.content
$.v.message.content.content
$.v.message.content.content_type
$.v.message.content.model_set_context
$.v.message.content.parts
$.v.message.content.parts[*]
$.v.message.content.repo_summary
$.v.message.content.repository
$.v.message.content.source_analysis_msg_id
$.v.message.content.structured_context
$.v.message.content.thoughts
$.v.message.content.thoughts[*]
$.v.message.content.thoughts[*].chunks
$.v.message.content.thoughts[*].content
$.v.message.content.thoughts[*].finished
$.v.message.content.thoughts[*].summary
$.v.message.content.user_instructions
$.v.message.content.user_profile
$.v.message.create_time
$.v.message.end_turn
$.v.message.id
$.v.message.metadata
$.v.message.metadata.can_save
$.v.message.metadata.citations
$.v.message.metadata.content_references
$.v.message.metadata.contextual_answers_message_type
$.v.message.metadata.continuation_message_id
$.v.message.metadata.conversation_followup_suggestions_eligible
$.v.message.metadata.cot_version
$.v.message.metadata.debug_sonic_thread_id
$.v.message.metadata.default_model_slug
$.v.message.metadata.disable_turn_actions
$.v.message.metadata.exclusive_key
$.v.message.metadata.finish_details
$.v.message.metadata.finish_details.stop_tokens
$.v.message.metadata.finish_details.stop_tokens[*]
$.v.message.metadata.finish_details.type
$.v.message.metadata.finished_duration_sec
$.v.message.metadata.hide_inline_actions
$.v.message.metadata.inline_cot_expandable_content
$.v.message.metadata.inline_cot_expandable_content.search_result_groups
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*]
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].domain
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*]
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].attribution
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].pub_date
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id.ref_index
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id.ref_type
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].ref_id.turn_index
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].snippet
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].title
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].type
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].entries[*].url
$.v.message.metadata.inline_cot_expandable_content.search_result_groups[*].type
$.v.message.metadata.inline_cot_expandable_content.source_message_ids
$.v.message.metadata.inline_cot_expandable_content.source_message_ids[*]
$.v.message.metadata.is_complete
$.v.message.metadata.is_contextual_answers_system_message
$.v.message.metadata.is_merged_message
$.v.message.metadata.is_message_fragment
$.v.message.metadata.is_user_system_message
$.v.message.metadata.is_visually_hidden_from_conversation
$.v.message.metadata.logical_answer_prefix_activity
$.v.message.metadata.logical_answer_prefix_activity.visibility
$.v.message.metadata.merged_message_id
$.v.message.metadata.message_source
$.v.message.metadata.message_type
$.v.message.metadata.model_dil_v2
$.v.message.metadata.model_dil_v2.appData
$.v.message.metadata.model_dil_v2.appData.opGenui
$.v.message.metadata.model_dil_v2.appData.opGenui.componentResults
$.v.message.metadata.model_dil_v2.appData.opGenui.interactionSurface
$.v.message.metadata.model_dil_v2.appData.opGenui.modelDataBindings
$.v.message.metadata.model_dil_v2.code
$.v.message.metadata.model_dil_v2.constants
$.v.message.metadata.model_dil_v2.constants["0"]
$.v.message.metadata.model_dil_v2.fallbackMarkdown
$.v.message.metadata.model_dil_v2.fallbackMarkdownVersion
$.v.message.metadata.model_slug
$.v.message.metadata.model_switcher_deny
$.v.message.metadata.parent_id
$.v.message.metadata.reasoning_end_time
$.v.message.metadata.reasoning_group_id
$.v.message.metadata.reasoning_recap_type
$.v.message.metadata.reasoning_start_time
$.v.message.metadata.reasoning_status
$.v.message.metadata.reasoning_title
$.v.message.metadata.reasoning_title_content_transition
$.v.message.metadata.reasoning_titles
$.v.message.metadata.reasoning_titles[*]
$.v.message.metadata.rebase_developer_message
$.v.message.metadata.rebase_system_message
$.v.message.metadata.request_id
$.v.message.metadata.resolved_model_slug
$.v.message.metadata.search_model_queries
$.v.message.metadata.search_model_queries.queries
$.v.message.metadata.search_model_queries.queries[*]
$.v.message.metadata.search_model_queries.type
$.v.message.metadata.search_result_groups
$.v.message.metadata.search_result_groups[*]
$.v.message.metadata.search_result_groups[*].domain
$.v.message.metadata.search_result_groups[*].entries
$.v.message.metadata.search_result_groups[*].entries[*]
$.v.message.metadata.search_result_groups[*].entries[*].attribution
$.v.message.metadata.search_result_groups[*].entries[*].pub_date
$.v.message.metadata.search_result_groups[*].entries[*].ref_id
$.v.message.metadata.search_result_groups[*].entries[*].ref_id.ref_index
$.v.message.metadata.search_result_groups[*].entries[*].ref_id.ref_type
$.v.message.metadata.search_result_groups[*].entries[*].ref_id.turn_index
$.v.message.metadata.search_result_groups[*].entries[*].snippet
$.v.message.metadata.search_result_groups[*].entries[*].title
$.v.message.metadata.search_result_groups[*].entries[*].type
$.v.message.metadata.search_result_groups[*].entries[*].url
$.v.message.metadata.search_result_groups[*].type
$.v.message.metadata.source_message_ids
$.v.message.metadata.source_message_ids[*]
$.v.message.metadata.story_events
$.v.message.metadata.streaming_parent_id
$.v.message.metadata.streaming_parent_revision
$.v.message.metadata.tool_icons
$.v.message.metadata.tool_icons[*]
$.v.message.metadata.tool_summary_type
$.v.message.metadata.turn_exchange_id
$.v.message.metadata.view_state
$.v.message.metadata.working_turn_id
$.v.message.recipient
$.v.message.status
$.v.message.update_time
$.v.message.weight
$.v[*].v.content_references
$.v[*].v.content_references[*]
$.v[*].v.content_references[*].alt
$.v[*].v.content_references[*].end_idx
$.v[*].v.content_references[*].has_images
$.v[*].v.content_references[*].matched_text
$.v[*].v.content_references[*].prefix
$.v[*].v.content_references[*].prompt_text
$.v[*].v.content_references[*].refs
$.v[*].v.content_references[*].safe_urls
$.v[*].v.content_references[*].sources
$.v[*].v.content_references[*].start_idx
$.v[*].v.content_references[*].type
$.v[*].v.finish_details.stop_tokens
$.v[*].v.finish_details.stop_tokens[*]
```

**`/backend-api/user_system_messages`** (HTTP)

```
$.about_model_message
$.about_user_message
$.name_user_message
$.other_user_message
$.role_user_message
$.traits_model_message
```

</details>

## claude.ai

- hosts: `claude.ai`
- site / family name: `claude.ai` / `claude.ai`
- member sessions: 11 (`20261022-013656-claude-961f1a`, `20261022-013242-claude-73e8f4`, `20261022-010820-claude-04d7c8`, `20261022-005921-claude-b89e71`, `20261022-005705-claude-940dd3`, `20261022-005153-claude-f51ef9`, `20261022-003705-claude-3a145f`, `20261022-002201-claude-933463`, `20261021-233122-claude-47009d`, `20261021-232724-claude-6da87f`, `20261021-221629-claude-ai-171679`)
- derived sessions: 11, streams: 31
- transports: `EVENT_SOURCE`, `HTTP`, `HTTP_STREAMED`
- profile / signature: not observed / `sha256:6d98bc713c733370`
- endpoint surface: 3 chat, 31 total

| transport | endpoint | field paths | delta / content field paths |
| --- | --- | --- | --- |
| HTTP | `/api/organizations/{id}/chat_conversations_v2` | 72 | `$.data[*].current_leaf_message_uuid`, `$.data[*].has_assistant_outputs`, `$.data[*].latest_assistant_output_at`, `$.data[*].latest_assistant_output_kind` |
| HTTP | `/api/organizations/{id}/chat_conversations/{id}/composer_notices` | 3 | not observed |
| HTTP_STREAMED | `/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline` | 4 | not observed |

## gemini.google.com

- hosts: `gemini.google.com`
- site / family name: `google.com` / `gemini.google.com`
- member sessions: 7 (`20261022-014040-gemini-15ba1a`, `20261022-012716-gemini-14856b`, `20261022-011937-gemini-google-com-4eeef5`, `20261022-011932-gemini-df639f`, `20261022-011331-gemini-8cc0e3`, `20261022-004043-gemini-f4e87c`, `20261021-233249-gemini-b2f6cb`)
- derived sessions: 7, streams: 10
- transports: `HTTP`, `HTTP_STREAMED`, `WEBSOCKET`
- profile / signature: not observed / `sha256:8fdf75458f41c8ed`
- endpoint surface: 1 chat, 10 total

| transport | endpoint | field paths | delta / content field paths |
| --- | --- | --- | --- |
| HTTP | `/_/BardChatUi/data/batchexecute` | 2 | not observed |

## www.kimi.com

- hosts: `www.kimi.com`
- site / family name: `kimi.com` / `www.kimi.com`
- member sessions: 4 (`20261022-005758-kimi-0df48c`, `20261022-004721-kimi-647f94`, `20261021-234829-kimi-bd2ca5`, `20261021-234405-kimi-da7165`)
- derived sessions: 4, streams: 12
- transports: `HTTP`
- profile / signature: not observed / `sha256:2bc427ceede101b0`
- endpoint surface: 1 chat, 12 total

| transport | endpoint | field paths | delta / content field paths |
| --- | --- | --- | --- |
| HTTP | `/apiv2/kimi.gateway.chat.v1.KimiPlusService/ListKimiPlus` | 29 | not observed |

## How the sites differ

Derived from the tables above: the transport of each chat endpoint, any observed end-of-stream
field path, and the field paths that look like a delta/content payload. "not observed" means the
capture does not show that property - it is not an assumption that it is absent at the site.

| site | chat transports | stream-end field path | delta / content carrier |
| --- | --- | --- | --- |
| agent.minimax.cn | not observed | not observed | not observed |
| chat.deepseek.com | HTTP, HTTP_SSE, HTTP_STREAMED | not observed | `$.content`, `$.data.biz_data.chat_session.current_message_id`, `$.data.biz_msg` (+31 more) |
| chat.qwen.ai | not observed | not observed | not observed |
| chat.z.ai | HTTP, HTTP_STREAMED | not observed | `$.chat.history.messages`, `$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"]`, `$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"].childrenIds` (+116 more) |
| chatgpt.com | HTTP, HTTP_SSE, HTTP_STREAMED | `$.input_message.end_turn`, `$.messages[*].content.thoughts[*].finished`, `$.messages[*].end_turn` (+23 more) | `$.about_model_message`, `$.about_user_message`, `$.conduit_token` (+333 more) |
| claude.ai | HTTP, HTTP_STREAMED | `$.metadata["Stream-Close-Reason"]`, `$.metadata["Stream-Close-Reason"][*]` | `$.data[*].current_leaf_message_uuid`, `$.data[*].has_assistant_outputs`, `$.data[*].latest_assistant_output_at` (+1 more) |
| gemini.google.com | HTTP | not observed | not observed |
| www.kimi.com | HTTP | not observed | not observed |

- agent.minimax.cn: no chat transport observed. End-of-stream signalling: not observed. Delta/content carrier: not observed.
- chat.deepseek.com serves chat over HTTP, HTTP_SSE, HTTP_STREAMED (4 chat endpoints of 8). End-of-stream signalling: not observed. Delta/content paths observed: `$.content`, `$.data.biz_data.chat_session.current_message_id` (+32 more).
- chat.qwen.ai: no chat transport observed. End-of-stream signalling: not observed. Delta/content carrier: not observed.
- chat.z.ai serves chat over HTTP, HTTP_STREAMED (2 chat endpoints of 5). End-of-stream signalling: not observed. Delta/content paths observed: `$.chat.history.messages`, `$.chat.history.messages["3a6ac30d-7ffc-4c71-a47b-73b42f5bcdc2"]` (+117 more).
- chatgpt.com serves chat over HTTP, HTTP_SSE, HTTP_STREAMED (9 chat endpoints of 47). End of stream is signalled by `$.input_message.end_turn`, `$.messages[*].content.thoughts[*].finished` (+24 more). Delta/content paths observed: `$.about_model_message`, `$.about_user_message` (+334 more).
- claude.ai serves chat over HTTP, HTTP_STREAMED (3 chat endpoints of 31). End of stream is signalled by `$.metadata["Stream-Close-Reason"]`, `$.metadata["Stream-Close-Reason"][*]`. Delta/content paths observed: `$.data[*].current_leaf_message_uuid`, `$.data[*].has_assistant_outputs` (+2 more).
- gemini.google.com serves chat over HTTP (1 chat endpoint of 10). End-of-stream signalling: not observed. Delta/content carrier: not observed.
- www.kimi.com serves chat over HTTP (1 chat endpoint of 12). End-of-stream signalling: not observed. Delta/content carrier: not observed.

## Coverage and gaps

AI chat sites declared in `src/profiles/sites/index.mjs` -> `ADAPTER_IDS`, and whether the captured
family store has a family for the site.

| adapter | label | adapter hosts | family | chat endpoints |
| --- | --- | --- | --- | --- |
| chatgpt | ChatGPT | chatgpt.com, www.chatgpt.com, chat.openai.com | `chatgpt.com` | 9 |
| claude | Claude | claude.ai, www.claude.ai | `claude.ai` | 3 |
| deepseek | DeepSeek | chat.deepseek.com | `chat.deepseek.com` | 4 |
| gemini | Gemini | gemini.google.com | `gemini.google.com` | 1 |
| kimi | Kimi | www.kimi.com, kimi.com, kimi.moonshot.cn | `www.kimi.com` | 1 |
| lmarena | LMArena | arena.ai, lmarena.ai, www.lmarena.ai, chat.lmsys.org | **NO FAMILY** | 0 |
| minimax | MiniMax | agent.minimax.cn, minimax.io, chat.minimax.io | `agent.minimax.cn` | 0 |
| qwen | Qwen Chat | chat.qwen.ai, qwen.ai | `chat.qwen.ai` | 0 |
| zai | Z.ai | chat.z.ai, z.ai, www.z.ai | `chat.z.ai` | 2 |

Sites with no captured family yet: `lmarena`.

- family files in the store: 20
- chat families reported: 8
- families with a chat-looking path but no chat surface / no adapter host (not reported above): `1337x.to` (1 chat-looking endpoint, no adapter host)
- unreadable family files: none

