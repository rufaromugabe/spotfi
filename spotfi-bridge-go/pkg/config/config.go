package config

import (
	"bufio"
	"os"
	"strings"
)

// Config holds environment variables
type Config struct {
	RouterID   string
	Token      string
	Mac        string
	WsURL      string
	RouterName string
	MQTTBroker string
}

// LoadEnv loads .env file manually to avoid extra dependencies
func LoadEnv() Config {
	var config Config
	file, err := os.Open("/etc/spotfi.env")
	if err != nil {
		// Fallback for local testing
		file, err = os.Open(".env")
		if err != nil {
			// It's okay if file doesn't exist, we might be using real env vars
			// But for this specific implementation, it seems to rely on the file or manual env vars
			// Let's just return empty and let the caller validate
			return config
		}
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.Trim(strings.TrimSpace(parts[1]), `"'`)

		switch key {
		case "SPOTFI_ROUTER_ID":
			config.RouterID = val
		case "SPOTFI_TOKEN":
			config.Token = val
		case "SPOTFI_MAC":
			config.Mac = val
		case "SPOTFI_WS_URL":
			config.WsURL = val
		case "SPOTFI_ROUTER_NAME":
			config.RouterName = val
		case "SPOTFI_MQTT_BROKER":
			config.MQTTBroker = val
		}
	}
	return config
}
