package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// InboundEvent is the wire format the bridge POSTs to the server.
//
// Both ends of this contract live in this repo, so the shape is flat and says
// exactly what it means — no envelope to unwrap, no probing for where the message
// might be hiding. server/src/inbox/whatsmeow.ts is the consuming side, and
// server/test/webhook.test.ts pins the signature that protects it.
type InboundEvent struct {
	Provider string `json:"provider"`
	// ID is the WhatsApp message id. The server dedupes on it, which is what
	// makes redelivery from the outbox safe.
	ID        string     `json:"id"`
	From      string     `json:"from"` // bare E.164 digits, never a LID
	Timestamp int64      `json:"timestamp"`
	Type      string     `json:"type"` // text | image | audio | interactive | other
	Text      string     `json:"text"`
	Reply     *ReplyInfo `json:"reply,omitempty"`
	Media     *MediaInfo `json:"media,omitempty"`
}

// ReplyInfo carries a button or list selection. The server turns it into the
// Spanish string the agent reads; user-facing wording does not live in the bridge.
type ReplyInfo struct {
	ID string `json:"id"`
}

// MediaInfo points at a decrypted file in the staging directory. The server
// reads it and unlinks it — the bridge never deletes what it handed over.
type MediaInfo struct {
	Path        string `json:"path"`
	Filename    string `json:"filename,omitempty"`
	ContentType string `json:"contentType,omitempty"`
}

// errUnresolvedSender means we could not turn the sender into a phone number.
var errUnresolvedSender = errors.New("could not resolve sender to a phone number")

type Inbound struct {
	client  *whatsmeow.Client
	outbox  *Outbox
	staging string
	log     waLog.Logger
	// lidToPN resolves a LID to a phone JID. Injected rather than reached for
	// through the client so resolvePhone — the riskiest logic here — is testable
	// without a paired device.
	lidToPN func(ctx context.Context, lid types.JID) (types.JID, error)
}

func NewInbound(client *whatsmeow.Client, outbox *Outbox, staging string, log waLog.Logger) *Inbound {
	return &Inbound{
		client:  client,
		outbox:  outbox,
		staging: staging,
		log:     log,
		lidToPN: lidResolver(client),
	}
}

// lidResolver looks the LID store up on every call instead of capturing it.
//
// An unpaired device has no sub-stores at all — sqlstore only attaches them once
// the device has a JID — so reading client.Store.LIDs at construction time panics
// on first boot. Capturing it after pairing would be no better: the resolver
// would hold the nil it saw at startup for the life of the process, and every LID
// would fail to resolve long after the store existed.
func lidResolver(client *whatsmeow.Client) func(context.Context, types.JID) (types.JID, error) {
	return func(ctx context.Context, lid types.JID) (types.JID, error) {
		if client == nil || client.Store == nil || client.Store.LIDs == nil {
			return types.EmptyJID, errors.New("lid store is not available yet")
		}
		return client.Store.LIDs.GetPNForLID(ctx, lid)
	}
}

// resolvePhone turns a sender JID into bare E.164 digits.
//
// This is the single most dangerous function in the bridge. WhatsApp is migrating
// senders to LIDs (`<id>@lid`), which are NOT phone numbers. Handing one to the
// server would strip cleanly to digits in normalizePhone and simply miss the
// OWNER_PHONE_NUMBERS allowlist — the owner would silently read as a customer,
// losing every owner tool with no error anywhere. Worse, a reply addressed back
// to that number would be routed to whoever really owns those digits.
//
// So an unresolvable sender is dropped rather than guessed at. Dropping one
// message is recoverable; answering a stranger as if they were the owner is not.
func (h *Inbound) resolvePhone(ctx context.Context, src types.MessageSource) (string, error) {
	if sender := src.Sender.ToNonAD(); sender.Server == types.DefaultUserServer {
		return sender.User, nil
	}
	// LID-addressed: the server usually sends the phone number alongside.
	if alt := src.SenderAlt.ToNonAD(); alt.Server == types.DefaultUserServer && alt.User != "" {
		return alt.User, nil
	}
	// Last resort: the LID→PN map whatsmeow keeps in its own store.
	if h.lidToPN == nil {
		return "", fmt.Errorf("%w: no lid resolver for %s", errUnresolvedSender, src.Sender)
	}
	pn, err := h.lidToPN(ctx, src.Sender.ToNonAD())
	if err != nil {
		return "", fmt.Errorf("%w: lid lookup failed: %v", errUnresolvedSender, err)
	}
	if pn.IsEmpty() || pn.Server != types.DefaultUserServer || pn.User == "" {
		return "", fmt.Errorf("%w: no mapping for %s", errUnresolvedSender, src.Sender)
	}
	return pn.User, nil
}

// stagingFile creates a fresh file in the staging directory. Random names rather
// than message ids: ids are attacker-influenced strings and would need escaping.
func (h *Inbound) stagingFile() (*os.File, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return nil, err
	}
	return os.Create(filepath.Join(h.staging, hex.EncodeToString(buf[:])+".bin"))
}

// downloadMedia decrypts inbound media straight to disk. Streaming to a file
// rather than into memory keeps a burst of large photos from ballooning the
// bridge's heap — whatsmeow hands us the plaintext either way.
//
// Takes the generic DownloadableMessage, so images and voice notes share one
// path: whatsmeow already maps AudioMessage to its own media type internally.
func (h *Inbound) downloadMedia(ctx context.Context, msg whatsmeow.DownloadableMessage) (string, error) {
	f, err := h.stagingFile()
	if err != nil {
		return "", fmt.Errorf("create staging file: %w", err)
	}
	defer f.Close()
	if err := h.client.DownloadToFile(ctx, msg, f); err != nil {
		// Leave nothing half-written behind for the server to trip over.
		os.Remove(f.Name())
		return "", fmt.Errorf("download media: %w", err)
	}
	return f.Name(), nil
}

// audioFilename names a voice note for whatever the server hands it to next.
//
// Staged files are always <random>.bin, because the staging name is chosen
// before anything is known about the content. Speech-to-text APIs take the file
// as a multipart upload and routinely reject or misread one whose name carries
// no format, so the real extension travels in MediaInfo.Filename instead — a
// field the contract already had and nothing populated until now.
//
// The mimetype arrives as "audio/ogg; codecs=opus", hence the cut at ';'.
func audioFilename(mimetype string) string {
	base, _, _ := strings.Cut(mimetype, ";")
	switch strings.TrimSpace(strings.ToLower(base)) {
	case "audio/mpeg", "audio/mp3":
		return "audio.mp3"
	case "audio/mp4", "audio/m4a", "audio/x-m4a":
		return "audio.m4a"
	case "audio/wav", "audio/x-wav":
		return "audio.wav"
	case "audio/webm":
		return "audio.webm"
	case "audio/flac":
		return "audio.flac"
	default:
		// WhatsApp voice notes are Opus in an Ogg container, and everything
		// unrecognised is far more likely to be that than anything else.
		return "audio.ogg"
	}
}

// Handle is the whatsmeow event handler. It must not block for long: whatsmeow
// dispatches events on its own goroutines, but a slow handler still delays the
// ones behind it, and media downloads are the slow part.
func (h *Inbound) Handle(rawEvt any) {
	evt, ok := rawEvt.(*events.Message)
	if !ok {
		return
	}
	// Our own outbound messages come back as events; so do groups, which this
	// product has no concept of. Both would create phantom conversations.
	if evt.Info.IsFromMe || evt.Info.IsGroup {
		return
	}

	ctx := context.Background()
	phone, err := h.resolvePhone(ctx, evt.Info.MessageSource)
	if err != nil {
		h.log.Errorf("dropping message %s: %v", evt.Info.ID, err)
		return
	}

	out := &InboundEvent{
		Provider:  "whatsmeow",
		ID:        evt.Info.ID,
		From:      phone,
		Timestamp: evt.Info.Timestamp.Unix(),
		Type:      "other",
	}

	msg := evt.Message
	switch {
	case msg.GetConversation() != "":
		out.Type = "text"
		out.Text = msg.GetConversation()

	case msg.GetExtendedTextMessage() != nil:
		out.Type = "text"
		out.Text = msg.GetExtendedTextMessage().GetText()

	// Voice notes and attached audio files are the SAME protobuf type — a voice
	// note is just an AudioMessage with PTT set — and both are equally
	// transcribable, so neither is treated specially here.
	//
	// Audio has no caption field at all, so Text stays empty and the server has
	// to keep this message alive on the strength of its media alone.
	case msg.GetAudioMessage() != nil:
		aud := msg.GetAudioMessage()
		path, err := h.downloadMedia(ctx, aud)
		if err != nil {
			// Same bargain as an image that failed to download: the message
			// still goes through, just without the part we could not fetch.
			// Unlike an image it carries no caption, so what arrives is empty —
			// which the server settles quietly rather than answering.
			h.log.Errorf("message %s: %v", evt.Info.ID, err)
			out.Type = "other"
			break
		}
		out.Type = "audio"
		out.Media = &MediaInfo{
			Path:        path,
			Filename:    audioFilename(aud.GetMimetype()),
			ContentType: aud.GetMimetype(),
		}

	case msg.GetImageMessage() != nil:
		img := msg.GetImageMessage()
		path, err := h.downloadMedia(ctx, img)
		if err != nil {
			// The message still goes through without its photo: the server is
			// built to tolerate media that did not arrive, and swallowing the
			// whole message would lose the caption with it.
			h.log.Errorf("message %s: %v", evt.Info.ID, err)
			out.Type = "other"
			out.Text = img.GetCaption()
			break
		}
		out.Type = "image"
		// The caption and nothing else — an uncaptioned photo carries no text.
		out.Text = img.GetCaption()
		out.Media = &MediaInfo{Path: path, ContentType: img.GetMimetype()}

	case msg.GetButtonsResponseMessage() != nil:
		r := msg.GetButtonsResponseMessage()
		out.Type = "interactive"
		out.Text = r.GetSelectedDisplayText()
		out.Reply = &ReplyInfo{ID: r.GetSelectedButtonID()}

	case msg.GetListResponseMessage() != nil:
		r := msg.GetListResponseMessage()
		out.Type = "interactive"
		out.Text = r.GetTitle()
		out.Reply = &ReplyInfo{ID: r.GetSingleSelectReply().GetSelectedRowID()}
	}

	payload, err := json.Marshal(out)
	if err != nil {
		h.log.Errorf("message %s: could not encode: %v", evt.Info.ID, err)
		return
	}
	if err := h.outbox.Enqueue(ctx, payload); err != nil {
		// Durability failed, so this message is genuinely lost. Loud on purpose.
		h.log.Errorf("message %s from %s LOST — could not persist to outbox: %v",
			evt.Info.ID, phone, err)
		return
	}
	h.log.Debugf("queued %s message %s from %s", out.Type, out.ID, out.From)
}
