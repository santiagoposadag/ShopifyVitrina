package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Delivery POSTs a queued event to the server's webhook.
//
// The signature is HMAC-SHA256 over the exact bytes we send, hex-encoded, in the
// header the server already verifies. That is not a coincidence: reusing the
// server's existing verifySignature means the whole authentication path for this
// provider is code that was already written and already tested.
type Delivery struct {
	url    string
	secret string
	client *http.Client
}

func NewDelivery(url, secret string) *Delivery {
	return &Delivery{
		url:    url,
		secret: secret,
		// Generous but finite: the server ACKs fast by design, and a hung POST
		// must not hold the queue's head slot forever.
		client: &http.Client{Timeout: 30 * time.Second},
	}
}

func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Send delivers one payload. It returns a *PermanentError only when retrying
// could not possibly help — a payload the server refuses to parse. Everything
// else, including auth failures and a missing endpoint, is retried: those are
// operator mistakes that get fixed, and discarding a real message over a typo in
// a URL would be the worse outcome.
func (d *Delivery) Send(ctx context.Context, payload []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.url, bytes.NewReader(payload))
	if err != nil {
		return &PermanentError{Err: fmt.Errorf("build request: %w", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-webhook-signature", sign(d.secret, payload))

	res, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("post to server: %w", err)
	}
	defer res.Body.Close()
	// Drain so the connection can be reused.
	body, _ := io.ReadAll(io.LimitReader(res.Body, 2048))

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return nil
	case res.StatusCode == http.StatusBadRequest,
		res.StatusCode == http.StatusRequestEntityTooLarge,
		res.StatusCode == http.StatusUnprocessableEntity:
		return &PermanentError{Err: fmt.Errorf("server rejected the payload (%d): %s",
			res.StatusCode, string(body))}
	default:
		return fmt.Errorf("server returned %d: %s", res.StatusCode, string(body))
	}
}
