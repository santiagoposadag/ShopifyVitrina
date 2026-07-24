package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	waLog "go.mau.fi/whatsmeow/util/log"

	_ "modernc.org/sqlite"
)

func testOutbox(t *testing.T) (*Outbox, *sql.DB) {
	t.Helper()
	db, err := openSQLite(filepath.Join(t.TempDir(), "outbox.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	o, err := OpenOutbox(db)
	if err != nil {
		t.Fatalf("schema: %v", err)
	}
	return o, db
}

// collector records deliveries and can be told to fail the first N attempts.
type collector struct {
	mu        sync.Mutex
	got       []string
	fail      int
	permanent bool
	done      chan struct{}
	want      int
}

func newCollector(want int) *collector {
	return &collector{done: make(chan struct{}), want: want}
}

func (c *collector) deliver(_ context.Context, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fail > 0 {
		c.fail--
		if c.permanent {
			return &PermanentError{Err: errors.New("rejected")}
		}
		return errors.New("temporary")
	}
	c.got = append(c.got, string(payload))
	if len(c.got) == c.want {
		close(c.done)
	}
	return nil
}

func (c *collector) delivered() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.got...)
}

func (c *collector) waitFor(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(d):
		t.Fatalf("timed out; delivered %v", c.delivered())
	}
}

func TestOutboxDeliversInInsertionOrder(t *testing.T) {
	// Photo order is listing order — the first photo becomes the storefront
	// cover — so out-of-order delivery silently reorders the owner's listing.
	o, _ := testOutbox(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const n = 25
	for i := 0; i < n; i++ {
		if err := o.Enqueue(ctx, []byte(fmt.Sprintf("photo-%02d", i))); err != nil {
			t.Fatalf("enqueue: %v", err)
		}
	}

	c := newCollector(n)
	go o.Run(ctx, c.deliver, waLog.Noop)
	c.waitFor(t, 5*time.Second)

	for i, got := range c.delivered() {
		if want := fmt.Sprintf("photo-%02d", i); got != want {
			t.Fatalf("position %d: got %q, want %q", i, got, want)
		}
	}
}

func TestOutboxSurvivesAProcessRestart(t *testing.T) {
	// The reason this queue exists: whatsmeow acks to WhatsApp as soon as the
	// event is handled, so anything held only in memory is gone on restart.
	o, db := testOutbox(t)
	ctx := context.Background()
	if err := o.Enqueue(ctx, []byte("survive-me")); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	// Reopen the same file, as a fresh process would.
	reopened, err := OpenOutbox(db)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if n, err := reopened.Pending(ctx); err != nil || n != 1 {
		t.Fatalf("pending = %d (err %v), want 1", n, err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	c := newCollector(1)
	go reopened.Run(runCtx, c.deliver, waLog.Noop)
	c.waitFor(t, 5*time.Second)

	if got := c.delivered(); got[0] != "survive-me" {
		t.Fatalf("got %q", got[0])
	}
}

func TestOutboxRetriesUntilDeliveryWorks(t *testing.T) {
	o, _ := testOutbox(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := o.Enqueue(ctx, []byte("eventually")); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	c := newCollector(1)
	c.fail = 2 // first two attempts fail; backoff is 2s then 4s
	go o.Run(ctx, c.deliver, waLog.Noop)
	c.waitFor(t, 20*time.Second)

	if n, err := o.Pending(context.Background()); err != nil || n != 0 {
		t.Fatalf("pending = %d (err %v), want the row gone after success", n, err)
	}
}

func TestOutboxDiscardsAPermanentFailureInsteadOfWedging(t *testing.T) {
	// Sequential delivery means a poisoned row would block every message behind
	// it forever. This is the same escape hatch MAX_BATCH_ATTEMPTS gives the
	// server's inbox.
	o, _ := testOutbox(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := o.Enqueue(ctx, []byte("poison")); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := o.Enqueue(ctx, []byte("good")); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	c := newCollector(1)
	c.fail = 1
	c.permanent = true
	go o.Run(ctx, c.deliver, waLog.Noop)
	c.waitFor(t, 5*time.Second)

	got := c.delivered()
	if len(got) != 1 || got[0] != "good" {
		t.Fatalf("got %v, want only the good row delivered", got)
	}
	if n, err := o.Pending(context.Background()); err != nil || n != 0 {
		t.Fatalf("pending = %d (err %v), want both rows cleared", n, err)
	}
}

func TestBackoffIsCappedSoRecoveryIsNotDelayedForever(t *testing.T) {
	if got := backoff(0); got != time.Second {
		t.Errorf("backoff(0) = %s, want 1s", got)
	}
	if got := backoff(3); got != 8*time.Second {
		t.Errorf("backoff(3) = %s, want 8s", got)
	}
	// A server down for an hour must not take an hour to be noticed again, and
	// a large attempt count must not overflow the shift into a negative.
	for _, attempts := range []int{6, 30, 63, 64, 200} {
		if got := backoff(attempts); got != time.Minute {
			t.Errorf("backoff(%d) = %s, want the 1m ceiling", attempts, got)
		}
	}
}
