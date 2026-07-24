package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The server verifies this exact signature with the code it already had. These
// constants are duplicated in server/test/whatsmeow-webhook.test.ts on purpose:
// they are the contract between the two languages, and a change on either side
// that is not mirrored breaks inbound delivery in a way neither suite would
// otherwise catch.
const (
	pinnedSecret    = "bridge-test-secret"
	pinnedBody      = `{"provider":"whatsmeow","id":"3EB0ABC","from":"573001112233"}`
	pinnedSignature = "5fdd6a2dc000ccd74070f754429c98b6547a4a18008f2522a53a29ac95f338e5"
)

func TestSignMatchesTheServersVerifier(t *testing.T) {
	if got := sign(pinnedSecret, []byte(pinnedBody)); got != pinnedSignature {
		t.Fatalf("sign() = %q, want %q — the server's verifySignature will reject this", got, pinnedSignature)
	}
}

func TestSendSignsTheExactBytesItPosts(t *testing.T) {
	// Signing a re-serialised copy rather than the bytes on the wire is the
	// classic way this breaks: key order changes and every signature fails.
	var gotBody []byte
	var gotSig string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotBody, _ = io.ReadAll(r.Body)
		gotSig = r.Header.Get("x-webhook-signature")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	d := NewDelivery(srv.URL, pinnedSecret)
	if err := d.Send(context.Background(), []byte(pinnedBody)); err != nil {
		t.Fatalf("send: %v", err)
	}
	if string(gotBody) != pinnedBody {
		t.Fatalf("body on the wire = %q", string(gotBody))
	}
	if gotSig != sign(pinnedSecret, gotBody) {
		t.Fatalf("signature %q does not cover the bytes actually sent", gotSig)
	}
}

func TestSendRetriesTransientFailuresButDiscardsRejectedPayloads(t *testing.T) {
	cases := map[int]struct {
		wantErr       bool
		wantPermanent bool
	}{
		http.StatusOK:                    {false, false},
		http.StatusAccepted:              {false, false},
		http.StatusBadRequest:            {true, true},
		http.StatusRequestEntityTooLarge: {true, true},
		http.StatusUnprocessableEntity:   {true, true},
		// A wrong secret or a wrong URL is an operator mistake that gets fixed.
		// Discarding real messages over a typo would be the worse failure.
		http.StatusUnauthorized:        {true, false},
		http.StatusNotFound:            {true, false},
		http.StatusTooManyRequests:     {true, false},
		http.StatusInternalServerError: {true, false},
		http.StatusBadGateway:          {true, false},
	}

	for code, want := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
		}))
		err := NewDelivery(srv.URL, pinnedSecret).Send(context.Background(), []byte(pinnedBody))
		srv.Close()

		if want.wantErr != (err != nil) {
			t.Errorf("status %d: err = %v, wantErr %t", code, err, want.wantErr)
			continue
		}
		var permanent *PermanentError
		if got := errors.As(err, &permanent); got != want.wantPermanent {
			t.Errorf("status %d: permanent = %t, want %t (err %v)", code, got, want.wantPermanent, err)
		}
	}
}

func TestSendTreatsAnUnreachableServerAsRetryable(t *testing.T) {
	// Port 1 on localhost refuses connections: the server being down mid-deploy
	// is the single most likely failure, and it must never discard a message.
	err := NewDelivery("http://127.0.0.1:1/webhook", pinnedSecret).
		Send(context.Background(), []byte(pinnedBody))
	if err == nil {
		t.Fatal("expected an error")
	}
	var permanent *PermanentError
	if errors.As(err, &permanent) {
		t.Fatalf("a connection failure must be retryable, got permanent: %v", err)
	}
}
