package main

import (
	"fmt"
	"os"
	"strings"
)

// Config is the bridge's runtime configuration, read once at boot.
//
// Everything is explicit and nothing that could destroy or misroute data gets a
// default, for the same reason AGENT_TRANSCRIPTS_DIR has none on the server: a
// convenient default here would point at a real directory on someone's laptop.
type Config struct {
	// StorePath is whatsmeow's own SQLite session store — the pairing lives here.
	// Losing this file means re-pairing the number by hand.
	StorePath string
	// OutboxPath is the durable delivery queue. Separate from the session store
	// so a corrupt queue can be dropped without unpairing the device.
	OutboxPath string
	// StagingDir is where decrypted inbound media is written for the server to
	// pick up. Shared volume; the server reads, then unlinks.
	StagingDir string
	// WebhookURL is the server's inbound endpoint.
	WebhookURL string
	// WebhookSecret signs the body we POST there (HMAC-SHA256, hex).
	WebhookSecret string
	// APIToken guards our own /send endpoint. The bridge can send WhatsApp
	// messages as the paired number, so this is never optional.
	APIToken string
	// Addr is the listen address for /send and /status.
	Addr string
	// PairPhone, when set, pairs by phone code instead of QR. Bare E.164 digits.
	PairPhone string
	// Debug turns on whatsmeow's protocol-level logging.
	Debug bool
}

func required(name string) (string, error) {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return "", fmt.Errorf("missing required environment variable: %s", name)
	}
	return v, nil
}

func optional(name, fallback string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	return v
}

// digitsOnly strips everything but digits, matching normalizePhone on the
// server. The two sides must agree or the owner allowlist silently misses.
func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func LoadConfig() (*Config, error) {
	cfg := &Config{
		StorePath:  optional("BRIDGE_STORE_PATH", "/session/whatsmeow.db"),
		OutboxPath: optional("BRIDGE_OUTBOX_PATH", "/session/outbox.db"),
		Addr:       optional("BRIDGE_ADDR", ":3002"),
		PairPhone:  digitsOnly(os.Getenv("BRIDGE_PAIR_PHONE")),
		Debug:      strings.EqualFold(optional("BRIDGE_DEBUG", "false"), "true"),
	}

	var err error
	if cfg.StagingDir, err = required("BRIDGE_STAGING_DIR"); err != nil {
		return nil, err
	}
	if cfg.WebhookURL, err = required("BRIDGE_WEBHOOK_URL"); err != nil {
		return nil, err
	}
	if cfg.WebhookSecret, err = required("BRIDGE_WEBHOOK_SECRET"); err != nil {
		return nil, err
	}
	if cfg.APIToken, err = required("BRIDGE_API_TOKEN"); err != nil {
		return nil, err
	}
	return cfg, nil
}
