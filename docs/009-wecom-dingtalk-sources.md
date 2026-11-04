# 009 WeCom and DingTalk Sources

This document plans and describes the 企业微信 (WeCom) and 钉钉 (DingTalk) message Sources. It follows the Source
contract in [008 Cookbook](008-cookbook.md) and changes no Engine rule: a platform message becomes a Trigger, a
conversation becomes a Thread, and a reply goes back through the Source's Channel. Both Sources join the same Policy,
admission tables and Outbox as GitHub and Feishu.

## Why two more kinds

Feishu reaches the agent through `lark-cli` and a bot identity. WeCom and DingTalk keep their own identity models and
APIs, and neither has a CLI comparable to `lark-cli`, so each gets its own kind that calls the platform API directly:

| | 企业微信 (WeCom) | 钉钉 (DingTalk) |
| --- | --- | --- |
| Receiving | HTTPS callback to a self-built app, signed and AES encrypted | Stream mode: outbound WebSocket, no public URL |
| Sending | `cgi-bin/message/send` as the app | `robot/groupMessages/send` or `robot/oToMessages/batchSend` as the robot |
| Identity | Corp + self-built app (`corpId`, `agentId`, `secret`) | App + robot (`clientId`, `clientSecret`, `robotCode`) |
| Reach | One-to-one conversations with the app | Direct chats and group chats that mention the robot |
| Deployment | Public HTTPS URL, reverse proxy, IP allowlist | Outbound internet access only |

The kinds are `wecom` and `dingtalk`. The settings keys are `source:wecom` and `source:dingtalk`, the plugin entries are
`dsh-superagent-wecom` and `dsh-superagent-dingtalk`, and the bundle inserts both disabled.

## Domain mapping

Both platforms have conversations, not forum threads. The conversation is therefore the Thread:

| Concept | WeCom | DingTalk |
| --- | --- | --- |
| Trigger | One message callback | One Stream robot callback |
| Trigger id | `wecom:<MsgId>` | `dingtalk:<msgId>` |
| Thread | The member's conversation with the app, `wecom:<UserID>` | The conversation, `dingtalk:<conversationId>` |
| Actor | `FromUserName` (member UserID) | `senderStaffId`, falling back to `senderId` |
| Human | Always, for messages (events are ignored) | Always, for messages |
| Addressed | `direct`: the app only receives messages addressed to it | `mention` in a group, `direct` in a one-to-one chat |
| Channel address | `{userId, messageId, agentId}` | `{conversationId, conversationType, staffId, messageId}` |
| Policy row | `direct` | `direct` or `group` |

Because the Thread is the conversation, a later message from the same member continues an open Ticket through the normal
follow-up rules. Neither platform exposes an app-accessible message history API, so the kinds provide no
`threadContext`: an assessment reads the Trigger's own text, not the conversation around it. Text and voice messages with
recognition become Triggers; images, files, cards and events are acknowledged but produce none. Image support is
future work.

## Credentials and configuration

Secrets stay out of the settings database, as they do for Feishu's `lark-cli`. A Source stores the path of a JSON file
whose content is re-read on every callback or reconnect; changing the file needs no restart and no settings save.

WeCom credentials file:

```json
{
  "corpId": "wwxxxxxxxxxxxxxxxx",
  "agentId": 1000002,
  "secret": "the app secret",
  "token": "the callback Token",
  "encodingAESKey": "the 43-character EncodingAESKey"
}
```

DingTalk credentials file:

```json
{
  "clientId": "dingxxxxxxxxxxxxxxxx",
  "clientSecret": "the app secret",
  "robotCode": "dingxxxxxxxxxxxxxxxx"
}
```

`robotCode` defaults to `clientId`. The file must be readable by the account running dsh-superagent. The settings page
shows only its absolute path, so the panel and its history never display a secret.

WeCom additionally listens on `host`, `port` and `path` (default `127.0.0.1:8091/wecom`). Keeping the loopback
interface as the default leaves TLS and routing to a reverse proxy; the public URL configured in the WeCom console must
forward to this path.

## 企业微信 (WeCom)

### Callback

The self-built app's "Receive Messages" settings name a URL, a Token and an EncodingAESKey.

- `GET /wecom?msg_signature&timestamp&nonce&echostr` verifies the SHA-1 signature over the Token, timestamp, nonce and
  the encrypted echo string, decrypts `echostr`, and returns the plaintext within one second.
- `POST /wecom?msg_signature&timestamp&nonce` reads the `<xml>` envelope, verifies the same signature over the
  encrypted body, decrypts it with AES-256-CBC and the EncodingAESKey, checks that the receiver id is the configured
  corp id, and turns the inner message into a Trigger.
- A bad signature is `403`; a malformed envelope is `400`; an intake failure is `500`. A valid callback is acknowledged
  with `success` after the Trigger is stored. WeCom repeats a callback only for transport failures, and the stable
  Trigger id makes a repeat harmless.

Decryption is the standard WeCom envelope: a 16-byte random prefix, a 4-byte big-endian body length, the XML body, and
the receive id, padded to a 32-byte block.

### App API

- `GET cgi-bin/gettoken?corpid&corpsecret` returns an access token, cached until shortly before it expires.
- `POST cgi-bin/message/send?access_token` sends the reply as a text message to the member, with the app's `agentid`.
- Error `40014`/`42001` refreshes the token once. Errors `40003` and `81013` (unknown member) settle the reply as `gone`;
  every other error is retried by the Outbox with backoff.

The corp's trusted-IP list must include the host that calls the API. The app must be visible to the members who are
expected to ask, and the callback URL must be reachable from the public internet.

## 钉钉 (DingTalk)

### Stream mode

The Source calls `v1.0/gateway/connections/open` with the robot credentials and a subscription to the robot callback
topic `/v1.0/im/bot/messages/get`, then opens the returned WebSocket with its ticket. Keeping the socket open needs no
public URL and no port mapping.

- A `CALLBACK` frame carries a robot message. The Source stores its Trigger and acknowledges the frame with the
  `messageId` from the frame; an unacknowledged frame is retried by DingTalk, and the stable Trigger id makes that safe.
- `SYSTEM` frames answer `ping` and `disconnect`; `EVENT` frames are acknowledged without becoming Triggers.
- The loop reconnects with exponential backoff (1 s doubling to 60 s) and reports an error only after three consecutive
  failures.

Group messages reach a robot only when they mention it. The Source records those as `mention`; one-to-one messages are
`direct`.

### Robot API

The Source uses the open API rather than the callback's `sessionWebhook`, because a ticket may run for hours and the
session Webhook expires:

- `POST v1.0/oauth2/accessToken` returns an access token, cached until shortly before it expires.
- A group reply goes to `v1.0/robot/groupMessages/send` with `openConversationId`; a one-to-one reply goes to
  `v1.0/robot/oToMessages/batchSend` with the member's `staffId`. Both use `msgKey: sampleText`.
- The returned `processQueryKey` is recorded as the effect's external id. It identifies the send, not the message, so
  retries still rely on the Outbox ledger rather than on a platform idempotency key.
- A `400` naming an unknown robot, member or conversation, or a `404`, settles the reply as `gone`.

The robot must be enabled for the organisation and added to the group; the members who may originate work are listed in
the Policy, not in the DingTalk console.

## Safety

- Callback and Stream payloads are untrusted data. Authorization comes only from the Source's allowed list and the
  admission table, never from the text.
- The WeCom signature is compared in constant time before any decryption, and the receive id must match the configured
  corp id.
- Credentials are read from a file outside the settings database and never placed in a worker's environment variables.
- Neither Channel logs a message body, a token or a secret in an error.

## Deployment and real-machine verification

The code-level tests use the real signature and encryption routines, a local callback server and a simulated Stream
socket. They do not contact WeCom or DingTalk. A real installation still needs the operator's own credentials:

1. Create the WeCom self-built app, enable "Receive Messages", set the callback URL to the reverse-proxied
   `https://<host>/wecom`, and copy the Token and EncodingAESKey. Add the host's egress IP to the trusted IP list.
2. Create the DingTalk app and robot, enable Stream mode, and copy the client id, secret and robot code.
3. Write both credentials files on the host, enable the two Sources in the panel, and save.
4. Verify, in order: the WeCom URL check passes; a member's message starts a Ticket; a group member's `@robot` message
   starts a Ticket; a ticket reply arrives in the same conversation; restarting dsh-superagent reconnects the Stream
   without losing or duplicating a message.

The first real-machine run is part of deployment, not of this change: without credentials the Sources stay paused with
a readable health detail instead of failing the whole application.

## Known limits

- Text only (WeCom also accepts voice recognition). Images, files and cards are acknowledged and ignored.
- No conversation history for assessments (`threadContext`), because neither API exposes one to the app.
- No platform idempotency key for replies: the Outbox ledger narrows, but cannot close, the crash window between a
  platform accepting a message and the ledger recording it.
- The WeCom Source requires a public HTTPS callback; only the DingTalk Source works on a private network.
- Group support for WeCom would need a different receive path (for example a group robot or customer-contact API) and is
  not part of this kind.
