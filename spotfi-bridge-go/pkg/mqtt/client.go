package mqtt

import (
	"fmt"
	"log"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

type Client struct {
	client   mqtt.Client
	routerID string
}

func NewClient(brokerURL, clientID, username, password string, onConnect mqtt.OnConnectHandler) (*Client, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(brokerURL)
	opts.SetClientID(clientID)
	opts.SetUsername(username)
	opts.SetPassword(password)
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
