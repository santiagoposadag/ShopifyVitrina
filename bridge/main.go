// Command bridge links a WhatsApp number to the Vitrina server using the
// whatsmeow library (the WhatsApp Web multidevice protocol).
//
// It is a sidecar, not a service the outside world talks to. Inbound messages
// are POSTed to the server's existing /webhook with an HMAC signature; outbound
// replies arrive on /send. Nothing here knows what a product or an owner is —
// role, batching, and agent logic all stay on the server.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/mdp/qrterminal/v3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"

	_ "modernc.org/sqlite"
)

// openSQLite opens a pure-Go SQLite connection.
//
// The driver is modernc's ("sqlite"), not mattn's ("sqlite3"), so the bridge
// builds without cgo and ships as a static binary. whatsmeow's dialect string is
// still "sqlite3" — it selects query syntax, not the driver — which is exactly
// why NewWithDB exists and sqlstore.New (which opens the driver itself) is not
// used here.
func openSQLite(path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create directory for %s: %w", path, err)
	}
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	// One writer. SQLite serializes writes anyway, and this makes that explicit
	// instead of surfacing as intermittent SQLITE_BUSY under a photo burst.
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping %s: %w", path, err)
	}
	return db, nil
}

// runPairing drives a first-time link. Returns once the pairing channel closes.
//
// Phone-code pairing is preferred over QR: it needs no image, no exposed web UI,
// and no screenshot of a terminal — the operator reads an 8-character code out of
// the container logs and types it into WhatsApp on the phone.
func runPairing(ctx context.Context, client *whatsmeow.Client, qrChan <-chan whatsmeow.QRChannelItem, pairPhone string, log waLog.Logger) {
	requested := false
	for item := range qrChan {
		switch item.Event {
		case "code":
			if pairPhone == "" {
				log.Infof("scan this QR code in WhatsApp → Settings → Linked devices (expires in %s)", item.Timeout)
				qrterminal.GenerateHalfBlock(item.Code, qrterminal.L, os.Stdout)
				continue
			}
			// Only ask once: each call invalidates the previous code, so retrying
			// on every refresh would hand the operator a code that dies instantly.
			if requested {
				continue
			}
			requested = true
			code, err := client.PairPhone(ctx, pairPhone, true, whatsmeow.PairClientChrome, "Vitrina Bridge")
			if err != nil {
				log.Errorf("could not request a pairing code for %s: %v", pairPhone, err)
				continue
			}
			log.Infof("=================================================")
			log.Infof(" PAIRING CODE for +%s : %s", pairPhone, code)
			log.Infof(" WhatsApp → Settings → Linked devices → Link with phone number")
			log.Infof("=================================================")
		case "error":
			log.Errorf("pairing failed: %v", item.Error)
		default:
			log.Infof("pairing: %s", item.Event)
		}
	}
	log.Infof("pairing channel closed")
}

func run() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}

	level := "INFO"
	if cfg.Debug {
		level = "DEBUG"
	}
	log := waLog.Stdout("Bridge", level, true)

	if err := os.MkdirAll(cfg.StagingDir, 0o755); err != nil {
		return fmt.Errorf("create staging dir: %w", err)
	}

	storeDB, err := openSQLite(cfg.StorePath)
	if err != nil {
		return err
	}
	defer storeDB.Close()

	outboxDB, err := openSQLite(cfg.OutboxPath)
	if err != nil {
		return err
	}
	defer outboxDB.Close()

	outbox, err := OpenOutbox(outboxDB)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Identify as a desktop client. WhatsApp uses this for the "linked devices"
	// entry the owner sees on their phone, so it should be recognisable.
	store.DeviceProps.Os = proto_String("Vitrina Bridge")

	container := sqlstore.NewWithDB(storeDB, "sqlite3", log.Sub("Store"))
	if err := container.Upgrade(ctx); err != nil {
		return fmt.Errorf("upgrade session store: %w", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return fmt.Errorf("load device: %w", err)
	}

	client := whatsmeow.NewClient(device, log.Sub("Client"))
	state := &State{}

	inbound := NewInbound(client, outbox, cfg.StagingDir, log.Sub("Inbound"))
	client.AddEventHandler(inbound.Handle)
	client.AddEventHandler(func(rawEvt any) {
		switch evt := rawEvt.(type) {
		case *events.Connected:
			state.SetConnected(true)
			log.Infof("connected to WhatsApp")
		case *events.Disconnected:
			state.SetConnected(false)
			log.Warnf("disconnected from WhatsApp; whatsmeow will reconnect")
		case *events.LoggedOut:
			state.SetLoggedOut()
			// The one failure a restart cannot fix. Someone has to re-pair.
			log.Errorf("LOGGED OUT (reason %s, on connect: %t) — the device was unlinked. "+
				"Re-pair the number; the bridge cannot recover on its own.", evt.Reason, evt.OnConnect)
		case *events.StreamReplaced:
			log.Errorf("stream replaced — another whatsmeow client connected with this session")
		case *events.TemporaryBan:
			log.Errorf("TEMPORARY BAN from WhatsApp: %s (expires %s)", evt.Code, evt.Expire)
		}
	})

	// Delivery and the queue are wired before connecting, so a message that
	// arrives during startup already has somewhere durable to land.
	delivery := NewDelivery(cfg.WebhookURL, cfg.WebhookSecret)
	go outbox.Run(ctx, delivery.Send, log.Sub("Outbox"))

	if client.Store.ID == nil {
		log.Infof("no paired device in the store — starting pairing")
		qrChan, err := client.GetQRChannel(ctx)
		if err != nil {
			return fmt.Errorf("open pairing channel: %w", err)
		}
		if err := client.Connect(); err != nil {
			return fmt.Errorf("connect: %w", err)
		}
		go runPairing(ctx, client, qrChan, cfg.PairPhone, log)
	} else {
		log.Infof("resuming session as %s", client.Store.ID)
		if err := client.Connect(); err != nil {
			return fmt.Errorf("connect: %w", err)
		}
	}

	api := NewAPI(client, outbox, state, cfg.APIToken, log.Sub("API"))
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Infof("bridge listening on %s", cfg.Addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Errorf("http server stopped: %v", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Infof("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	client.Disconnect()
	return nil
}

// proto_String avoids pulling protobuf into this file just for a *string.
func proto_String(s string) *string { return &s }

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}
