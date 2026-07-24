package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	waLog "go.mau.fi/whatsmeow/util/log"
)

// Logger is whatsmeow's logger interface, aliased so this file reads on its own
// terms. The bridge logs through one implementation end to end.
type Logger = waLog.Logger

// Outbox is the bridge's durable delivery queue.
//
// Kapso gave the server at-least-once delivery for free: it retried our webhook
// at 10/40/90s, so a message survived the server being mid-restart. whatsmeow
// has no such thing — it acks to WhatsApp as soon as the event is handled, and
// an event dropped here is gone for good. It never reaches the inbox table, so
// replayPending cannot recover it either. This queue is that guarantee, moved
// into our own process: an event is durable BEFORE it is delivered.
//
// Delivery is strictly sequential in insertion order, and that is a requirement
// rather than a simplification. Photo order is listing order — the first photo
// becomes the storefront's cover — so a concurrent dispatcher that let photo 4
// overtake photo 2 would quietly reorder the owner's listing. A stuck row
// therefore blocks the queue, which is the correct trade: delayed and ordered
// beats prompt and scrambled.
type Outbox struct {
	db *sql.DB
	// wake carries a non-blocking nudge from Enqueue so the dispatcher reacts
	// immediately instead of waiting out its poll interval.
	wake chan struct{}
}

const outboxSchema = `
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    BLOB    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`

func OpenOutbox(db *sql.DB) (*Outbox, error) {
	if _, err := db.Exec(outboxSchema); err != nil {
		return nil, fmt.Errorf("create outbox schema: %w", err)
	}
	return &Outbox{db: db, wake: make(chan struct{}, 1)}, nil
}

// Enqueue makes an event durable. It must be called before the event is
// considered handled, never after delivery is attempted.
func (o *Outbox) Enqueue(ctx context.Context, payload []byte) error {
	_, err := o.db.ExecContext(ctx,
		`INSERT INTO outbox (payload, created_at) VALUES (?, ?)`,
		payload, time.Now().Unix(),
	)
	if err != nil {
		return fmt.Errorf("enqueue: %w", err)
	}
	select {
	case o.wake <- struct{}{}:
	default: // A nudge is already pending; the dispatcher will see this row.
	}
	return nil
}

// Pending reports how many events are waiting. Exposed for /status.
func (o *Outbox) Pending(ctx context.Context) (int, error) {
	var n int
	err := o.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM outbox`).Scan(&n)
	return n, err
}

type outboxRow struct {
	id       int64
	payload  []byte
	attempts int
}

func (o *Outbox) head(ctx context.Context) (*outboxRow, error) {
	row := &outboxRow{}
	err := o.db.QueryRowContext(ctx,
		`SELECT id, payload, attempts FROM outbox ORDER BY id LIMIT 1`,
	).Scan(&row.id, &row.payload, &row.attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return row, nil
}

// PermanentError marks a delivery that will never succeed, so the dispatcher
// discards the row instead of blocking the queue behind it forever. This mirrors
// MAX_BATCH_ATTEMPTS on the server: a poison message must not wedge the pipeline.
type PermanentError struct{ Err error }

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

// Deliver sends one payload. A nil error deletes the row; a *PermanentError
// discards it with a loud log; anything else is retried with backoff, forever.
type Deliver func(ctx context.Context, payload []byte) error

// backoff grows to a one-minute ceiling. Unbounded growth would mean a server
// that was down for an hour takes an hour to notice it came back.
func backoff(attempts int) time.Duration {
	d := time.Second << attempts
	if d > time.Minute || d <= 0 {
		return time.Minute
	}
	return d
}

// Run dispatches until ctx is cancelled. It owns the queue: exactly one Run per
// Outbox, or the ordering guarantee is gone.
func (o *Outbox) Run(ctx context.Context, deliver Deliver, log Logger) {
	// A poll interval as a floor under the wake channel: a nudge dropped because
	// one was already pending must never leave a row sitting unnoticed.
	const idlePoll = 5 * time.Second

	for {
		row, err := o.head(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Errorf("outbox: reading head failed: %v", err)
			if !sleep(ctx, idlePoll) {
				return
			}
			continue
		}
		if row == nil {
			select {
			case <-ctx.Done():
				return
			case <-o.wake:
			case <-time.After(idlePoll):
			}
			continue
		}

		err = deliver(ctx, row.payload)
		if err == nil {
			if _, delErr := o.db.ExecContext(ctx, `DELETE FROM outbox WHERE id = ?`, row.id); delErr != nil {
				// The row survives and will be delivered again. At-least-once is
				// the contract, and the server dedupes on the WhatsApp message id.
				log.Errorf("outbox: delivered row %d but could not delete it: %v", row.id, delErr)
			}
			continue
		}
		if ctx.Err() != nil {
			return
		}

		var permanent *PermanentError
		if errors.As(err, &permanent) {
			log.Errorf("outbox: DISCARDING row %d after a permanent failure: %v — payload: %s",
				row.id, err, string(row.payload))
			if _, delErr := o.db.ExecContext(ctx, `DELETE FROM outbox WHERE id = ?`, row.id); delErr != nil {
				log.Errorf("outbox: could not discard row %d: %v", row.id, delErr)
			}
			continue
		}

		row.attempts++
		if _, updErr := o.db.ExecContext(ctx,
			`UPDATE outbox SET attempts = ? WHERE id = ?`, row.attempts, row.id,
		); updErr != nil {
			log.Errorf("outbox: could not record attempt for row %d: %v", row.id, updErr)
		}
		wait := backoff(row.attempts)
		log.Warnf("outbox: delivery of row %d failed (attempt %d), retrying in %s: %v",
			row.id, row.attempts, wait, err)
		if !sleep(ctx, wait) {
			return
		}
	}
}

// sleep waits for d, reporting false if ctx was cancelled first.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
