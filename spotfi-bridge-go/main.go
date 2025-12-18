package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"spotfi-bridge/pkg/config"
	"spotfi-bridge/pkg/metrics"
	"spotfi-bridge/pkg/mqtt"
	"spotfi-bridge/pkg/rpc"
	"spotfi-bridge/pkg/session"

	paho "github.com/eclipse/paho.mqtt.golang"
	"github.com/gorilla/websocket"
)

// Global state
var (
	cfg        config.Config
	mqttClient *mqtt.Client
)

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// --- WebSocket Tunnel Handler (On-Demand) ---
func startTunnel(targetURL string) {
	log.Printf("Starting Tunnel to %s", targetURL)
	u, err := url.Parse(targetURL)
	if err != nil {
		log.Printf("Invalid tunnel URL: %v", err)
		return
	}

	// Append token if not present (usually passed in URL, but just in case)
	if u.Query().Get("token") == "" {
		q := u.Query()
		q.Set("token", cfg.Token)
		u.RawQuery = q.Encode()
	}

	c, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		log.Printf("Tunnel connection failed: %v", err)
		return
	}
	defer c.Close()

	log.Println("Tunnel Connected")

	// Create a dedicated session manager for this connection
	// We wrap the write to the WS
	wsSender := func(v interface{}) error {
		return c.WriteJSON(v)
	}
	sm := session.NewSessionManager(wsSender)

	// Read Loop
	for {
		var msg map[string]interface{}
		err := c.ReadJSON(&msg)
		if err != nil {
			log.Println("Tunnel read error (closed):", err)
			break
		}

		msgType, _ := msg["type"].(string)
		switch msgType {
		case "x-start":
			go sm.HandleStart(msg)
		case "x-data":
			sm.HandleData(msg)
		case "x-stop":
			sm.HandleStop(msg)
		case "ping":
			c.WriteJSON(map[string]string{"type": "pong"})
		}
	}
	log.Println("Tunnel Closed")
}

func main() {
	log.SetOutput(os.Stderr)

	// CLI Flags
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version", "-v":
			fmt.Fprintln(os.Stdout, "spotfi-bridge v2.0.0 (MQTT)")
			os.Exit(0)
		case "--test", "-t":
			cfg = config.LoadEnv()
			fmt.Fprintln(os.Stdout, "Configuration OK")
			os.Exit(0)
		}
	}

	cfg = config.LoadEnv()
	if cfg.Token == "" {
		log.Fatal("Missing configuration: SPOTFI_TOKEN not set")
	}

	// Determine Broker URL
	brokerURL := os.Getenv("SPOTFI_MQTT_BROKER")
	if brokerURL == "" {
		brokerURL = "tcp://emqx:1883" // Default for manual testing
		log.Printf("Using default broker: %s", brokerURL)
	}

	// Router ID (Token only mode supported but need ID for topics)
	routerID := cfg.RouterID
	if routerID == "" {
		if len(cfg.Mac) > 0 {
			routerID = cfg.Mac
		} else {
			// Fallback: This is risky in real dev but fine for this bridge logic
			routerID = "unknown_device"
			log.Println("WARNING: No RouterID or MAC found. Using 'unknown_device'. RPC may fail.")
		}
	}

	// Connect to MQTT
	clientID := fmt.Sprintf("router-%s", routerID)
	// Connect to MQTT with Exponential Backoff
	var client *mqtt.Client
	var err error
	backoff := 1 * time.Second
	const maxBackoff = 30 * time.Second

	for {
		client, err = mqtt.NewClient(brokerURL, clientID, routerID, cfg.Token, func(c paho.Client) {
			log.Println("MQTT Client Connected")
		})
		if err == nil {
			break
		}
		log.Printf("Failed to connect to MQTT broker: %v. Retrying in %v...", err, backoff)
		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
	mqttClient = client
	defer mqttClient.Close()

	// Topic Handlers

	// 1. RPC Requests
	rpcTopic := fmt.Sprintf("spotfi/router/%s/rpc/request", routerID)
	err = mqttClient.Subscribe(rpcTopic, func(c paho.Client, m paho.Message) {
		var msg map[string]interface{}
		if err := json.Unmarshal(m.Payload(), &msg); err != nil {
			log.Printf("Invalid RPC JSON: %v", err)
			return
		}

		// Respond via MQTT
		sendFunc := func(v interface{}) error {
			payload, _ := json.Marshal(v)
			return mqttClient.Publish(fmt.Sprintf("spotfi/router/%s/rpc/response", routerID), payload)
		}

		go rpc.HandleRPC(msg, sendFunc)
	})
	if err != nil {
		log.Printf("Failed to subscribe to RPC: %v", err)
	}

	// 2. Shell Connect Trigger
	shellTopic := fmt.Sprintf("spotfi/router/%s/shell/connect", routerID)
	mqttClient.Subscribe(shellTopic, func(c paho.Client, m paho.Message) {
		var msg map[string]interface{}
		if err := json.Unmarshal(m.Payload(), &msg); err != nil {
			return
		}
		// Expecting "url" in payload
		if target, ok := msg["url"].(string); ok {
			go startTunnel(target)
		}
	})

	log.Printf("SpotFi Bridge (MQTT) Started. ID: %s", routerID)

	// Metric Loop
	ticker := time.NewTicker(30 * time.Second)
	metricsTopic := fmt.Sprintf("spotfi/router/%s/metrics", routerID)

	// Send initial metrics
	initialMetrics := map[string]interface{}{
		"type":    "metrics",
		"metrics": metrics.GetMetrics(),
	}
	mqttClient.Publish(metricsTopic, initialMetrics)

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	for {
		select {
		case <-ticker.C:
			data := map[string]interface{}{
				"type":    "metrics",
				"metrics": metrics.GetMetrics(),
			}
			mqttClient.Publish(metricsTopic, data)
		case <-quit:
			log.Println("Shutting down...")
			return
		}
	}
}
