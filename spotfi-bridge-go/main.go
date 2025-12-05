package main

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"spotfi-bridge/pkg/config"
	"spotfi-bridge/pkg/metrics"
	"spotfi-bridge/pkg/rpc"
	"spotfi-bridge/pkg/session"

	"github.com/gorilla/websocket"
)

// min returns the minimum of two integers
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Global state
var (
	cfg            config.Config
	wsConn         *websocket.Conn
	wsMu           sync.Mutex
	sessionManager *session.SessionManager
)

// Thread-safe WebSocket write
func sendJSON(v interface{}) error {
	wsMu.Lock()
	defer wsMu.Unlock()
	if wsConn == nil {
		return fmt.Errorf("no connection")
	}
	return wsConn.WriteJSON(v)
}

// --- Main Loop ---

func connect() error {
	u, err := url.Parse(cfg.WsURL)
	if err != nil {
		return err
	}

	// Add Query Params
	// Token-only mode: if RouterID is not set, connect with just token
	q := u.Query()
	q.Set("token", cfg.Token)
	if cfg.RouterID != "" {
		// Legacy mode: include router ID
		q.Set("id", cfg.RouterID)
	}
	if cfg.Mac != "" {
		q.Set("mac", cfg.Mac)
	}
	if cfg.RouterName != "" {
		q.Set("name", cfg.RouterName)
	}
	u.RawQuery = q.Encode()

	log.Printf("Connecting to %s", u.String())

	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		return err
	}

	wsMu.Lock()
	wsConn = c
	wsMu.Unlock()

	log.Println("Connected!")

	// Send initial metrics
	sendJSON(map[string]interface{}{
		"type":    "metrics",
		"metrics": metrics.GetMetrics(),
	})

	// Read Loop
	for {
		var msg map[string]interface{}
		err := c.ReadJSON(&msg)
		if err != nil {
			log.Println("Read error:", err)
			return err
		}

		msgType, _ := msg["type"].(string)
		switch msgType {
		case "rpc":
			go rpc.HandleRPC(msg, sendJSON)
		case "x-start":
			go sessionManager.HandleStart(msg)
		case "x-data":
			sessionManager.HandleData(msg)
		case "x-stop":
			sessionManager.HandleStop(msg)
		}
	}
}

func main() {
	// Ensure errors go to stderr
	log.SetOutput(os.Stderr)

	// Check for version/test flags
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v":
			fmt.Fprintln(os.Stdout, "spotfi-bridge v1.0.0")
			os.Exit(0)
		case "--test", "-t":
			fmt.Fprintln(os.Stdout, "Testing configuration...")
			cfg = config.LoadEnv()
			if cfg.Token == "" {
				fmt.Fprintln(os.Stderr, "ERROR: Missing SPOTFI_TOKEN")
				os.Exit(1)
			}
			if cfg.WsURL == "" {
				fmt.Fprintln(os.Stderr, "ERROR: Missing SPOTFI_WS_URL")
				os.Exit(1)
			}
			fmt.Fprintln(os.Stdout, "Configuration OK:")
			if cfg.RouterID != "" {
				fmt.Fprintf(os.Stdout, "  Router ID: %s\n", cfg.RouterID)
			} else {
				fmt.Fprintln(os.Stdout, "  Mode: Token-only (cloud will identify router)")
			}
			fmt.Fprintf(os.Stdout, "  Token: %s...\n", cfg.Token[:min(8, len(cfg.Token))])
			fmt.Fprintf(os.Stdout, "  WebSocket URL: %s\n", cfg.WsURL)
			if cfg.Mac != "" {
				fmt.Fprintf(os.Stdout, "  MAC Address: %s\n", cfg.Mac)
			}
			os.Exit(0)
		case "--help", "-h":
			fmt.Fprintln(os.Stdout, "Usage: spotfi-bridge [--version|--test|--help]")
			fmt.Fprintln(os.Stdout, "  --version, -v  Show version")
			fmt.Fprintln(os.Stdout, "  --test, -t     Test configuration")
			fmt.Fprintln(os.Stdout, "  --help, -h     Show this help")
			os.Exit(0)
		}
	}

	// If we get here, try to load env and start
	cfg = config.LoadEnv()
	if cfg.Token == "" {
		log.Fatal("Missing configuration: SPOTFI_TOKEN not set")
	}
	if cfg.WsURL == "" {
		log.Fatal("Missing configuration: SPOTFI_WS_URL not set")
	}
	
	// Token-only mode is supported (RouterID optional)
	if cfg.RouterID == "" {
		log.Println("Token-only mode: Router will be identified by token from cloud")
	}

	// Initialize Session Manager
	sessionManager = session.NewSessionManager(sendJSON)

	// Heartbeat ticker
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		for range ticker.C {
			if wsConn != nil {
				sendJSON(map[string]interface{}{
					"type":    "metrics",
					"metrics": metrics.GetMetrics(),
				})
			}
		}
	}()

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)

	// Connection manager
	go func() {
		for {
			err := connect()
			if err != nil {
				log.Println("Connection failed or closed, retrying in 5s...")
				wsMu.Lock()
				if wsConn != nil {
					wsConn.Close()
					wsConn = nil
				}
				wsMu.Unlock()
				time.Sleep(5 * time.Second)
			}
		}
	}()

	<-interrupt
	log.Println("Shutting down...")
	if wsConn != nil {
		wsConn.Close()
	}
}
