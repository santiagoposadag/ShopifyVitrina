package main

import (
	"regexp"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"
)

// WhatsApp validates the code-pairing display name server-side and rejects
// anything that is not `Browser (OS)` naming a browser and OS it recognises. The
// rejection is an opaque `info query returned status 400: bad-request` that says
// nothing about the name, so a well-meaning edit to something branded — which is
// exactly what this once was — breaks pairing entirely with no clue why.
func TestPairDisplayNameMatchesWhatWhatsAppAccepts(t *testing.T) {
	shape := regexp.MustCompile(`^[A-Z][A-Za-z]+ \([A-Z][A-Za-z ]+\)$`)
	if !shape.MatchString(pairDisplayName) {
		t.Fatalf("pairDisplayName = %q, want `Browser (OS)` — WhatsApp answers 400 otherwise", pairDisplayName)
	}

	// Only names WhatsApp is known to accept. Adding one is fine; inventing one
	// is how this breaks, so make it a deliberate edit with a test to update.
	allowed := map[string]bool{
		"Chrome (Linux)":   true,
		"Chrome (macOS)":   true,
		"Chrome (Windows)": true,
		"Firefox (Linux)":  true,
		"Safari (macOS)":   true,
		"Edge (Windows)":   true,
	}
	if !allowed[pairDisplayName] {
		t.Fatalf("pairDisplayName = %q is not a known-good value; verify against a real "+
			"pairing attempt before adding it here", pairDisplayName)
	}
}

// The browser named in the display name and the PairClientType are two halves of
// one claim about what this client is. Letting them disagree is asking the server
// to notice.
func TestPairClientTypeAgreesWithTheDisplayName(t *testing.T) {
	browser := strings.SplitN(pairDisplayName, " ", 2)[0]
	expected := map[string]whatsmeow.PairClientType{
		"Chrome":  whatsmeow.PairClientChrome,
		"Firefox": whatsmeow.PairClientFirefox,
		"Safari":  whatsmeow.PairClientSafari,
		"Edge":    whatsmeow.PairClientEdge,
	}
	want, known := expected[browser]
	if !known {
		t.Fatalf("no PairClientType mapped for browser %q", browser)
	}
	if pairClientType != want {
		t.Fatalf("pairClientType = %q but the display name says %q", pairClientType, browser)
	}
}

// whatsmeow rejects these before they ever reach the server; digitsOnly runs on
// BRIDGE_PAIR_PHONE first, so it must not manufacture a number that gets that far.
func TestPairPhoneNormalisationKeepsNumbersInternational(t *testing.T) {
	// A leading zero is a national-format number and whatsmeow refuses it.
	if got := digitsOnly("+57 312 825 0410"); got != "573128250410" {
		t.Fatalf("digitsOnly stripped to %q", got)
	}
	if got := digitsOnly("0312 825 0410"); !strings.HasPrefix(got, "0") {
		t.Fatalf("digitsOnly(%q) = %q — a national-format number must stay recognisable "+
			"as one so whatsmeow can reject it", "0312 825 0410", got)
	}
}
