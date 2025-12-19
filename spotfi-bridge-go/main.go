/*
SpotFi Bridge (Go) - MQTT-Only Architecture

This bridge connects OpenWrt routers to the SpotFi API using MQTT exclusively.
No WebSocket connections are used - all communication flows through the MQTT broker.

Topics:
  - spotfi/router/{id}/metrics       - Router heartbeat and metrics (published every 30s)
  - spotfi/router/{id}/status        - Online/Offline status (with LWT)
  - spotfi/router/{id}/rpc/request   - Incoming RPC commands from API
  - spotfi/router/{id}/rpc/response  - RPC responses to API
  - spotfi/router/{id}/x/in          - Incoming x-tunnel data from API
  - spotfi/router/{id}/x/out         - Outgoing x-tunnel data to API
*/
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"spotfi-bridge/pkg/config"
	"spotfi-bridge/pkg/metrics"
	"spotfi-bridge/pkg/mqtt"
	"spotfi-bridge/pkg/rpc"
	"spotfi-bridge/pkg/session"
	paho "github.com/eclipse/paho.mqtt.golang"
)

// Global state
var (
	cfg        config.Config
	mqttClient *mqtt.Client
	sm         *session.SessionManager
)

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// Main entry point
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
	// Try environment variable first, then config file, then default
	brokerURL := os.Getenv("SPOTFI_MQTT_BROKER")
	if brokerURL == "" {
		brokerURL = cfg.MQTTBroker
	}
	if brokerURL == "" {
		brokerURL = "tcp://emqx:1883" // Default for manual testing
		log.Printf("Using default broker: %s", brokerURL)
	} else {
		log.Printf("Using MQTT broker: %s", brokerURL)
	}

	// Router ID - Required for MQTT authentication (username = router ID, password = token)
	// EMQX authenticates using: SELECT token FROM routers WHERE id = username
	routerID := cfg.RouterID
	if routerID == "" {
		log.Fatal("Missing configuration: SPOTFI_ROUTER_ID not set. Router ID is required for MQTT authentication.")
	}

	// Connect to MQTT
	// Username = Router ID (from database)
	// Password = Router Token
	clientID := fmt.Sprintf("router-%s", routerID)
	log.Printf("Connecting to MQTT broker with username='%s' (router ID)", routerID)
	
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
		// Provide more helpful error messages for authentication failures
		errMsg := err.Error()
		if strings.Contains(errMsg, "not Authorized") || strings.Contains(errMsg, "NotAuthorized") {
			log.Printf("MQTT authentication failed: username='%s' (router ID), password='%s...' (token)", routerID, cfg.Token[:min(8, len(cfg.Token))])
			log.Printf("Verify: 1) Router ID '%s' exists in database, 2) Token matches router's token in database", routerID)
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

	// Initialize global SessionManager pointing to MQTT
	sm = session.NewSessionManager(func(topic string, v interface{}) error {
		payload, _ := json.Marshal(v)
		// Use provided topic if possible, fallback to standard out topic
		pubTopic := topic
		if pubTopic == "" {
			pubTopic = fmt.Sprintf("spotfi/router/%s/x/out", routerID)
		}
		return mqttClient.Publish(pubTopic, payload)
	})

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

	// 2. X-Tunnel Data (Inbound - from API to Router)
	xTopic := fmt.Sprintf("spotfi/router/%s/x/in", routerID)
	mqttClient.Subscribe(xTopic, func(c paho.Client, m paho.Message) {
		var msg map[string]interface{}
		if err := json.Unmarshal(m.Payload(), &msg); err != nil {
			return
		}

		msgType, _ := msg["type"].(string)
		switch msgType {
		case "x-start":
			go sm.HandleStart(msg)
		case "x-data":
			sm.HandleData(msg)
		case "x-stop":
			sm.HandleStop(msg)
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
