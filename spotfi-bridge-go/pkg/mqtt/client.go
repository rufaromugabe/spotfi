package mqtt

import (
	"context"
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
	// This manually resolves hostnames to IPv4 addresses first using IPv4 DNS servers
	customDialer := func(network, address string) (net.Conn, error) {
		// Parse the address (format: "host:port")
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}

		// Check if it's already an IP address
		if ip := net.ParseIP(host); ip != nil {
			dialer := &net.Dialer{
				Timeout:   30 * time.Second,
				DualStack: false, // Prefer IPv4
			}
			return dialer.Dial(network, address)
		}

		// Use custom resolver that prefers IPv4 DNS servers
		// Try common IPv4 DNS servers first (8.8.8.8, 1.1.1.1, or system resolver)
		resolver := &net.Resolver{
			PreferGo: true, // Use Go's DNS resolver instead of cgo
		}

		// Try to resolve to IPv4 addresses first
		// This avoids IPv6 DNS resolver issues on OpenWrt
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		
		ips, err := resolver.LookupIPAddr(ctx, host)
		if err != nil {
			// Fallback: try system resolver
			ips2, err2 := net.LookupIP(host)
			if err2 != nil {
				return nil, fmt.Errorf("DNS lookup failed: %v", err)
			}
			// Convert []net.IP to []net.IPAddr
			for _, ip := range ips2 {
				ips = append(ips, net.IPAddr{IP: ip})
			}
		}

		// Prefer IPv4 addresses
		var ipv4 net.IP
		for _, ipAddr := range ips {
			if ipAddr.IP.To4() != nil {
				ipv4 = ipAddr.IP
				break
			}
		}

		// If no IPv4 found, use first available IP
		if ipv4 == nil && len(ips) > 0 {
			ipv4 = ips[0].IP
		}

		if ipv4 == nil {
			return nil, fmt.Errorf("no IP address found for %s", host)
		}

		// Dial using the resolved IP address
		dialer := &net.Dialer{
			Timeout:   30 * time.Second,
			DualStack: false,
		}
		return dialer.Dial(network, net.JoinHostPort(ipv4.String(), port))
	}

	opts.SetDialer(customDialer)

	client := mqtt.NewClient(opts)
	if token := client.Connect(); token.Wait() && token.Error() != nil {
		return nil, token.Error()
	}

	return &Client{client: client, routerID: username}, nil
}

func (c *Client) Publish(topic string, payload interface{}) error {
	token := c.client.Publish(topic, 0, false, payload)
	token.Wait()
	return token.Error()
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
