package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// State is the connection health the /status endpoint reports.
//
// LoggedOut is the one that matters operationally. A linked device is unpaired
// whenever the primary phone stays offline past WhatsApp's window, and the
// failure is silent: the process keeps running and simply stops receiving. We
// cannot alert over WhatsApp about losing WhatsApp, so this is what monitoring
// has to watch.
type State struct {
	mu        sync.RWMutex
	connected bool
	loggedOut bool
	since     time.Time
}

func (s *State) SetConnected(v bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.connected = v
	s.since = time.Now()
}

func (s *State) SetLoggedOut() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loggedOut = true
	s.connected = false
	s.since = time.Now()
}

func (s *State) Snapshot() (connected, loggedOut bool, since time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connected, s.loggedOut, s.since
}

type API struct {
	client *whatsmeow.Client
	outbox *Outbox
	state  *State
	token  string
	log    waLog.Logger
}

func NewAPI(client *whatsmeow.Client, outbox *Outbox, state *State, token string, log waLog.Logger) *API {
	return &API{client: client, outbox: outbox, state: state, token: token, log: log}
}

// authorized compares the bearer token in constant time. The bridge can send
// messages as the paired number, so this endpoint is as sensitive as the API key
// it protects.
func (a *API) authorized(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	provided := strings.TrimPrefix(header, "Bearer ")
	if provided == header { // no "Bearer " prefix
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(a.token)) == 1
}

type sendRequest struct {
	To   string `json:"to"`
	Body string `json:"body"`
}

// maxBodyRunes guards against a runaway agent reply. WhatsApp's own limit is
// larger; this is about not sending a novel to a customer by accident.
const maxBodyRunes = 4096

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *API) handleSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
		return
	}
	if !a.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	var req sendRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	to := digitsOnly(req.To)
	if to == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_to"})
		return
	}
	if req.Body == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "empty_body"})
		return
	}
	if len([]rune(req.Body)) > maxBodyRunes {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body_too_long"})
		return
	}

	// Built from digits we just normalized, never from a JID string that arrived
	// over the wire — that is what keeps a reply from being addressed to a LID.
	jid := types.NewJID(to, types.DefaultUserServer)
	msg := &waE2E.Message{Conversation: proto.String(req.Body)}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	resp, err := a.client.SendMessage(ctx, jid, msg)
	if err != nil {
		a.log.Errorf("send to %s failed: %v", to, err)
		// 502, not 400: the server should retry the agent turn, not give up.
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": resp.ID})
}

func (a *API) handleStatus(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	connected, loggedOut, since := a.state.Snapshot()
	pending, err := a.outbox.Pending(r.Context())
	if err != nil {
		a.log.Warnf("status: counting the outbox failed: %v", err)
		pending = -1
	}
	var jid string
	if a.client.Store.ID != nil {
		jid = a.client.Store.ID.String()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"connected":     connected,
		"loggedOut":     loggedOut,
		"pairedAs":      jid,
		"outboxPending": pending,
		"since":         since.UTC().Format(time.RFC3339),
	})
}

// handleHealth reports process liveness only, deliberately NOT connection state.
// A restart cannot fix being logged out, so making the container unhealthy for
// that would just produce a crash loop that hides the real problem. Watch
// /status for whether the channel actually works.
func (a *API) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/send", a.handleSend)
	mux.HandleFunc("/status", a.handleStatus)
	mux.HandleFunc("/health", a.handleHealth)
	return mux
}
