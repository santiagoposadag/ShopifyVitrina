# Voice notes

Inbound WhatsApp audio is transcribed before it reaches the agent. Both roles: an owner listing a property by voice and a customer asking a question by voice are answered the same way as if they had typed.

## Why this exists

An owner sent a voice note and got **total silence** — no reply, no error, nothing in the inbox. Neither Claude nor DeepSeek accepts audio at all, so this was never a model problem: the message was discarded before anything could answer it.

It was dropped three times over, and the first drop was the decisive one:

| # | Where | What happened |
| --- | --- | --- |
| 0 | `bridge/inbound.go` | No `AudioMessage` case in the type switch → event emitted as `type: "other"`, no text, no media |
| 1 | `server/src/inbox/whatsmeow.ts` | Fell through to `kind: "other"` with an empty body; the media block was discarded |
| 2 | `server/src/inbox/webhook.ts` | An empty body is dropped unless it is an image → `200 OK`, **no inbox row** |

No row meant no batch, no batch meant no agent turn. Silence is the *designed* outcome for an event kind we do not handle — audio had simply never been added to the list.

## How a voice note travels now

```
WhatsApp voice note (Opus in Ogg)
  → bridge decrypts it to the staging volume, type "audio",
    real format in MediaInfo.Filename
  → webhook stores the bytes in AUDIO_DIR, writes an inbox row
    with audio_path set          ← fast ACK, no network call
  → batcher worker transcribes, writes the words back into
    agent_text, clears audio_path, deletes the file
  → the agent answers the text
```

The split at the webhook is the important part. **Transcription never runs in the request handler.** The bridge's outbox is strictly sequential, so a slow handler stalls every message queued behind it — a local read off a shared volume is affordable there, a call to a speech API is not.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRANSCRIPTION_API_KEY` | — | Enables the feature. **Unset = off**, and a voice note gets a reply asking the person to write. |
| `TRANSCRIPTION_BASE_URL` | `https://api.groq.com/openai/v1` | Any OpenAI-shaped `/audio/transcriptions` endpoint. |
| `TRANSCRIPTION_MODEL` | `whisper-large-v3-turbo` | |
| `TRANSCRIPTION_MAX_BYTES` | `26214400` (25 MB) | Larger audio is skipped rather than billed. |
| `AUDIO_DIR` | `./data/audio` (compose: `/data/audio`) | Where notes wait to be transcribed. |

The key is loaded from gopass by `scripts/with-secrets.sh`, trying `vitrina/transcription_api_key` then `vitrina/groq_api_key`. Unlike the other secrets it is **optional** — a missing entry does not fail the run, because the assistant still answers everyone who types. The server says so once at boot:

```
TRANSCRIPTION_API_KEY is not set — inbound voice notes will be answered with a request to write instead
```

Provider-neutral by design, the same way the LLM provider is: Groq, OpenAI or anything else speaking that endpoint is a URL change, not a code change.

## Cost

Groq's published rate for `whisper-large-v3-turbo` is **$0.04 per hour of audio**, and **audio is billed at a minimum of 10 seconds per request** — so a 3-second note costs the same as a 10-second one.

| | |
| --- | --- |
| shortest billable note | $0.00011 |
| 30-second note | $0.00033 |
| 1,000 notes/month averaging 20 s | **≈ $0.22/month** |

Negligible next to the agent turn each note triggers. Measured latency on a 12-second Spanish note: **421 ms**.

Source: [groq.com/pricing](https://groq.com/pricing), verified 2026-07-27.

### The one cost leak worth knowing

Transcription happens in the batcher, which runs **before** the per-phone rate limiter in `index.ts`. A customer spamming voice notes therefore incurs speech-to-text cost the limiter never sees. `TRANSCRIPTION_MAX_BYTES` bounds the cost *per message*, but it is not a limiter. If abuse ever appears, a per-phone daily transcription cap is the real fix.

## Design decisions

**A voice note is persisted as `kind: 'text'`, not `'media'`.** Two reasons. `buildBatchText` renders a media row as a photo *count* and treats its text as a caption grouped underneath — the wrong shape for a transcript. And `schedule()` upgrades a media burst to the 45-second window, which is right for a photo set arriving in waves and wrong for one voice note: nobody should wait 45 s for a reply to a single message. It also avoids widening the `CHECK (kind IN ('text','media'))` constraint, which SQLite cannot do with `ALTER TABLE` on a live database.

**The transcript is written back to the row as it is produced.** Batches retry up to `MAX_BATCH_ATTEMPTS`; without the write-back every retry would re-upload and re-bill the same seconds of speech. Clearing `audio_path` in the same statement is what marks the audio as already paid for.

**Audio never enters `pending_media`.** `attach_pending_photos` consumes *every* unattached row for a phone with no type filter, so a stored voice note would be attached to the next product and published to the storefront as a photo.

**Audio is stored outside `MEDIA_DIR`.** That directory is served publicly at `/media`. A customer's voice note is private speech and must not land somewhere a guessable URL reaches. `AUDIO_DIR` is never routed.

**The file is deleted once the batch is settled** — whether or not the words were recovered. `audio_path` is cleared either way, so nothing will ever read it again; keeping it would leak one file per failed note, forever.

**Failure never returns to silence.** No provider, an unreadable file, a refused request — all fall back to a line asking the person to write. This matters more than it looks: an empty batch is settled `done` **without running the agent**, so an untranscribable note would reproduce the original bug exactly.

**The real format travels in `MediaInfo.Filename`.** The bridge stages every file as `<random>.bin`, and speech APIs reject or misread an upload whose name says nothing about its format. That field existed in the contract and nothing had ever populated it.

## Limits

- **The transcript reaches the agent as ordinary typed text** — no voice-note label, no read-back confirmation. This was a deliberate product decision. The consequence is real: a mistranscribed number on the owner path can reach the public storefront, and the existing grounding rules in the owner prompt are the only guard. Revisit if it bites.
- **Voice notes and attached audio files are treated identically.** A voice note is just an `AudioMessage` with `PTT` set; both are equally transcribable.
- **Still unhandled:** video, documents, stickers, locations and contacts. All continue to settle quietly, exactly as audio used to.
- **Spanish is hard-coded** (`language: "es"`), which is both more accurate and faster than autodetection on short, noisy clips.

## Verifying

```bash
npm run test -w server     # includes the regression that reproduces the original bug
cd bridge && go test ./...
```

The webhook tests drive the real route and were checked against a deliberately reintroduced bug: restoring the old drop condition fails four of them.

End to end:

```bash
docker compose build server bridge
./scripts/with-secrets.sh --profile deepseek docker compose up -d
docker compose logs -f server | grep -E "voice note transcribed|agent turn complete"
```

Send a voice note as the owner and as a customer. Both must get a real answer.

To test the transcriber alone, without WhatsApp — this produces audio in the exact format WhatsApp sends:

```bash
say -v Paulina -o note.aiff "Busco un apartamento de tres alcobas en Laureles"
ffmpeg -i note.aiff -c:a libopus -b:a 24k note.ogg
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every note answered with "please write it" | No `TRANSCRIPTION_API_KEY`. Check the boot warning. |
| Notes silently ignored, no inbox row | The bridge image predates this change — rebuild it. |
| `voice note transcribed` logged but no reply | Look further down for the agent turn; the failure is downstream. |
| Transcript is nonsense | Check the note actually reached the API as Ogg; the format rides in `MediaInfo.Filename`. |

## Related

- [provider-swap.md](./provider-swap.md) — the LLM provider, configured the same way
- [secrets-management.md](./secrets-management.md) — gopass entries
- [coolify-deploy.md](./coolify-deploy.md) — deployment variables
