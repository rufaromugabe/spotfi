package mqtt

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

type Client struct {
	client   mqtt.Client
	routerID string
}

// NewClient creates a new MQTT client
// username: Router ID (from database) - used for EMQX authentication
// password: Router Token - used for EMQX authentication
// EMQX authenticates using: SELECT token FROM routers WHERE id = username
func NewClient(brokerURL, clientID, username, password string, onConnect mqtt.OnConnectHandler) (*Client, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(brokerURL)
	opts.SetClientID(clientID)
	opts.SetUsername(username) // Router ID
	opts.SetPassword(password) // Router Token
	opts.SetCleanSession(true) // Set to false if we want queued messages while offline
	
	// LWT (Last Will and Testament)
	// When connection is lost, broker publishes OFFLINE status
	// LWT (Last Will and Testament)
	// When connection is lost, broker publishes OFFLINE status
	opts.SetWill(fmt.Sprintf("spotfi/router/%s/status", username), "OFFLINE", 1, true)

	opts.SetOnConnectHandler(func(c mqtt.Client) {
		log.Println("MQTT Connected")
		// Publish ONLINE status
		c.Publish(fmt.Sprintf("spotfi/router/%s/status", username), 1, true, "ONLINE")
		if onConnect != nil {
			onConnect(c)
		}
	})

	opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
		log.Printf("MQTT Connection Lost: %v", err)
	})

	// Custom dialer that prefers IPv4 to avoid IPv6 DNS issues on OpenWrt
	// Use Go's pure DNS resolver (PreferGo) and disable dual-stack to prefer IPv4
	customDialer := &net.Dialer{
		Timeout:   30 * time.Second,
		DualStack: false, // Disable dual-stack to prefer IPv4
		Resolver: &net.Resolver{
			PreferGo: true, // Use Go's DNS resolver instead of cgo (avoids IPv6 DNS issues)
		},
	}

	opts.SetDialer(customDialer)

	client := mqtt.NewClient(opts)
	if token := client.Connect(); token.Wait() && token.Error() != nil {
		return nil, token.Error()
	}

	return &Client{client: client, routerID: username}, nil
}

func (c *Client) Publish(topic string, payload interface{}) error {
	// Convert payload to []byte
	var payloadBytes []byte
	var err error
	
	switch v := payload.(type) {
	case []byte:
		payloadBytes = v
	case string:
		payloadBytes = []byte(v)
	default:
		// JSON marshal maps, structs, etc.
		payloadBytes, err = json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("failed to marshal payload: %w", err)
		}
	}
	
	// Use QoS 0 (fire-and-forget) and don't wait for acknowledgment
	// This reduces latency for terminal data
	token := c.client.Publish(topic, 0, false, payloadBytes)
	// Check for immediate errors without blocking
	// For QoS 0, this is fire-and-forget, so we don't wait
	if token.Error() != nil {
		return token.Error()
	}
	return nil
}

func (c *Client) Subscribe(topic string, handler mqtt.MessageHandler) error {
	token := c.client.Subscribe(topic, 0, handler)
	token.Wait()
	return token.Error()
}

func (c *Client) Close() {
	// Publish OFFLINE before disconnecting gracefully
	c.client.Publish(fmt.Sprintf("spotfi/router/%s/status", c.routerID), 1, true, "OFFLINE").Wait()
	c.client.Disconnect(250)
}
