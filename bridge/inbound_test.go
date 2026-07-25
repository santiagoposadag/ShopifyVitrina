package main

import (
	"context"
	"errors"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

// A LID that WOULD normalize to plausible-looking digits on the server. That is
// the whole danger: nothing downstream can tell it apart from a phone number.
const lidUser = "128372817364"
const phoneUser = "573001112233"

func lidSource(alt types.JID, resolver func(context.Context, types.JID) (types.JID, error)) (*Inbound, types.MessageSource) {
	return &Inbound{lidToPN: resolver}, types.MessageSource{
		Sender:         types.NewJID(lidUser, types.HiddenUserServer),
		SenderAlt:      alt,
		AddressingMode: types.AddressingModeLID,
	}
}

func TestResolvePhoneUsesThePhoneJIDDirectly(t *testing.T) {
	h := &Inbound{}
	src := types.MessageSource{Sender: types.NewJID(phoneUser, types.DefaultUserServer)}

	got, err := h.resolvePhone(context.Background(), src)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != phoneUser {
		t.Fatalf("got %q, want %q", got, phoneUser)
	}
}

func TestResolvePhonePrefersSenderAltOverALID(t *testing.T) {
	// The regression this pins: returning Sender.User here hands the server a
	// LID, the owner allowlist misses, and the owner silently becomes a customer.
	h, src := lidSource(types.NewJID(phoneUser, types.DefaultUserServer), nil)

	got, err := h.resolvePhone(context.Background(), src)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != phoneUser {
		t.Fatalf("got %q, want the phone number %q — a LID must never reach the server", got, phoneUser)
	}
}

func TestResolvePhoneFallsBackToTheLIDMap(t *testing.T) {
	called := false
	h, src := lidSource(types.EmptyJID, func(_ context.Context, lid types.JID) (types.JID, error) {
		called = true
		if lid.User != lidUser {
			t.Fatalf("looked up %q, want %q", lid.User, lidUser)
		}
		return types.NewJID(phoneUser, types.DefaultUserServer), nil
	})

	got, err := h.resolvePhone(context.Background(), src)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Fatal("the LID map was never consulted")
	}
	if got != phoneUser {
		t.Fatalf("got %q, want %q", got, phoneUser)
	}
}

func TestResolvePhoneFailsRatherThanGuessingFromALID(t *testing.T) {
	// Both fallbacks empty. Returning the LID's digits would look like success
	// and would address replies to a stranger who really owns those digits.
	for name, resolver := range map[string]func(context.Context, types.JID) (types.JID, error){
		"lookup errors": func(context.Context, types.JID) (types.JID, error) {
			return types.EmptyJID, errors.New("boom")
		},
		"lookup finds nothing": func(context.Context, types.JID) (types.JID, error) {
			return types.EmptyJID, nil
		},
		"no resolver at all": nil,
	} {
		t.Run(name, func(t *testing.T) {
			h, src := lidSource(types.EmptyJID, resolver)
			got, err := h.resolvePhone(context.Background(), src)
			if err == nil {
				t.Fatalf("resolved to %q; an unresolvable sender must be an error", got)
			}
			if !errors.Is(err, errUnresolvedSender) {
				t.Fatalf("got %v, want errUnresolvedSender", err)
			}
			if got != "" {
				t.Fatalf("got %q alongside an error; must be empty", got)
			}
		})
	}
}

func TestResolvePhoneIgnoresTheDevicePartOfAJID(t *testing.T) {
	// An AD-JID (user.agent:device) must still resolve to the bare number, or
	// every device the contact owns would read as a different person.
	h := &Inbound{}
	sender := types.NewJID(phoneUser, types.DefaultUserServer)
	sender.Device = 3
	src := types.MessageSource{Sender: sender}

	got, err := h.resolvePhone(context.Background(), src)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != phoneUser {
		t.Fatalf("got %q, want %q", got, phoneUser)
	}
}

func TestLIDResolverSurvivesAnUnpairedDevice(t *testing.T) {
	// On first boot there is no pairing, so whatsmeow has attached no sub-stores
	// to the device and client.Store.LIDs is nil. Reading it eagerly panicked the
	// process before it could even show a pairing code.
	for name, client := range map[string]*whatsmeow.Client{
		"nil client":     nil,
		"no store":       {},
		"store, no LIDs": {Store: &store.Device{}},
	} {
		t.Run(name, func(t *testing.T) {
			resolve := lidResolver(client)
			got, err := resolve(context.Background(), types.NewJID(lidUser, types.HiddenUserServer))
			if err == nil {
				t.Fatalf("resolved to %s; want an error rather than a panic", got)
			}
		})
	}
}

func TestUnpairedDeviceDropsALIDInsteadOfGuessing(t *testing.T) {
	// The two failures compose: an unpaired bridge that receives a LID-addressed
	// message must drop it, not hand the server a LID as if it were a phone.
	h := &Inbound{lidToPN: lidResolver(&whatsmeow.Client{})}
	src := types.MessageSource{Sender: types.NewJID(lidUser, types.HiddenUserServer)}

	if got, err := h.resolvePhone(context.Background(), src); err == nil {
		t.Fatalf("resolved to %q; want errUnresolvedSender", got)
	} else if !errors.Is(err, errUnresolvedSender) {
		t.Fatalf("got %v, want errUnresolvedSender", err)
	}
}

func TestDigitsOnlyMatchesTheServersNormalisation(t *testing.T) {
	// normalizePhone on the server strips everything that is not a digit. If the
	// two ever disagree, the owner allowlist misses and the role boundary moves.
	cases := map[string]string{
		"+57 300 111 2233": "573001112233",
		"57-300-111-2233":  "573001112233",
		"573001112233":     "573001112233",
		"":                 "",
	}
	for in, want := range cases {
		if got := digitsOnly(in); got != want {
			t.Errorf("digitsOnly(%q) = %q, want %q", in, got, want)
		}
	}
}
