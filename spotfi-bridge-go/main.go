package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

// Config holds environment variables
type Config struct {
	RouterID   string
	Token      string
	Mac        string
	WsURL      string
	RouterName string
}

// Global state
var (
	config      Config
	wsConn      *websocket.Conn
	wsMu        sync.Mutex
	done        chan struct{}
	xSessions   = make(map[string]*XSession)
	xMu         sync.Mutex
)

type XSession struct {
	ID     string
	Cmd    *exec.Cmd
	Pty    *os.File
	Active bool
}

// Load .env file manually to avoid extra dependencies
func loadEnv() {
	file, err := os.Open("/etc/spotfi.env")
	if err != nil {
		// Fallback for local testing
		file, err = os.Open(".env")
		if err != nil {
			log.Fatal("Could not open env file")
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
		}
	}
}

// Thread-safe WebSocket write
func sendJSON(v interface{}) error {
	wsMu.Lock()
	defer wsMu.Unlock()
	if wsConn == nil {
		return fmt.Errorf("no connection")
	}
	return wsConn.WriteJSON(v)
}

// --- UBUS / RPC Handling ---

type RPCRequest struct {
	ID     string          `json:"id"`
	Path   string          `json:"path"`
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args"`
}

func handleRPC(msg map[string]interface{}) {
	// Re-marshal to struct for easier handling
	tmp, _ := json.Marshal(msg)
	var req RPCRequest
	json.Unmarshal(tmp, &req)

	// Execute ubus command via OS exec (safest/most portable way on OpenWrt)
	argsStr := "{}"
	if len(req.Args) > 0 {
		argsStr = string(req.Args)
	}

	cmd := exec.Command("ubus", "call", req.Path, req.Method, argsStr)
	var out bytes.Buffer
	cmd.Stdout = &out

	response := map[string]interface{}{
		"type": "rpc-result",
		"id":   req.ID,
	}

	if err := cmd.Run(); err != nil {
		response["status"] = "error"
		response["error"] = err.Error()
	} else {
		response["status"] = "success"
		var result interface{}
		// Try parsing as JSON, if empty string or invalid, return raw or empty
		if out.Len() > 0 {
			if err := json.Unmarshal(out.Bytes(), &result); err == nil {
				response["result"] = result
			} else {
				response["result"] = map[string]interface{}{}
			}
		} else {
			response["result"] = map[string]interface{}{}
		}
	}

	sendJSON(response)
}

func getMetrics() map[string]interface{} {
	// 1. System Info
	cmdSys := exec.Command("ubus", "call", "system", "info")
	outSys, _ := cmdSys.Output()
	var sysInfo map[string]interface{}
	json.Unmarshal(outSys, &sysInfo)

	// 2. Client List
	cmdClients := exec.Command("ubus", "call", "uspot", "client_list")
	outClients, _ := cmdClients.Output()
	var clientList map[string]interface{}
	json.Unmarshal(outClients, &clientList)

	// Calculate active users
	activeUsers := 0
	for _, iface := range clientList {
		if clients, ok := iface.(map[string]interface{}); ok {
			activeUsers += len(clients)
		}
	}

	// Extract memory
	var totalMem, freeMem float64
	if mem, ok := sysInfo["memory"].(map[string]interface{}); ok {
		totalMem, _ = mem["total"].(float64)
		freeMem, _ = mem["free"].(float64)
	}

	// Extract Load
	var cpuLoad float64
	if load, ok := sysInfo["load"].([]interface{}); ok && len(load) > 0 {
		// OpenWrt load is usually integer scaled by 65535
		if l, ok := load[0].(float64); ok {
			cpuLoad = (l / 65535.0) * 100.0
		}
	}

	return map[string]interface{}{
		"uptime":      fmt.Sprintf("%.0f", sysInfo["uptime"]),
		"cpuLoad":     cpuLoad,
		"totalMemory": totalMem,
		"freeMemory":  freeMem,
		"activeUsers": activeUsers,
	}
}

// --- X Tunnel (PTY) Handling ---

func handleXStart(msg map[string]interface{}) {
	sessionID, _ := msg["sessionId"].(string)
	if sessionID == "" {
		return
	}

	// Clean existing if present
	handleXStop(msg)

	// Create command
	c := exec.Command("/bin/sh")
	c.Env = append(os.Environ(), "TERM=xterm-256color", "HOME=/root")

	// Start PTY
	f, err := pty.Start(c)
	if err != nil {
		sendJSON(map[string]interface{}{
			"type":      "x-error",
			"sessionId": sessionID,
			"error":     err.Error(),
		})
		return
	}

	// Set window size (standard)
	pty.Setsize(f, &pty.Winsize{Rows: 24, Cols: 80})

	sess := &XSession{
		ID:     sessionID,
		Cmd:    c,
		Pty:    f,
		Active: true,
	}

	xMu.Lock()
	xSessions[sessionID] = sess
	xMu.Unlock()

	// Ack
	sendJSON(map[string]interface{}{
		"type":      "x-started",
		"sessionId": sessionID,
		"status":    "ready",
	})

	// Reader Loop
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := f.Read(buf)
			if err != nil {
				break // EOF or error (process died)
			}
			if n > 0 {
				dataB64 := base64.StdEncoding.EncodeToString(buf[:n])
				sendJSON(map[string]interface{}{
					"type":      "x-data",
					"sessionId": sessionID,
					"data":      dataB64,
				})
			}
		}
		// Cleanup when read fails (process exit)
		handleXStop(map[string]interface{}{"sessionId": sessionID})
	}()
}

func handleXData(msg map[string]interface{}) {
	sessionID, _ := msg["sessionId"].(string)
	dataB64, _ := msg["data"].(string)

	xMu.Lock()
	sess, exists := xSessions[sessionID]
	xMu.Unlock()

	if !exists || !sess.Active {
		return
	}

	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err == nil {
		sess.Pty.Write(data)
	}
}

func handleXStop(msg map[string]interface{}) {
	sessionID, _ := msg["sessionId"].(string)

	xMu.Lock()
	defer xMu.Unlock()

	if sess, ok := xSessions[sessionID]; ok {
		sess.Active = false
		sess.Pty.Close()
		if sess.Cmd.Process != nil {
			sess.Cmd.Process.Kill()
		}
		delete(xSessions, sessionID)
	}
}

// --- Main Loop ---

func connect() error {
	u, err := url.Parse(config.WsURL)
	if err != nil {
		return err
	}

	// Add Query Params
	q := u.Query()
	q.Set("id", config.RouterID)
	q.Set("token", config.Token)
	q.Set("mac", config.Mac)
	if config.RouterName != "" {
		q.Set("name", config.RouterName)
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
		"metrics": getMetrics(),
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
			go handleRPC(msg)
		case "x-start":
			go handleXStart(msg)
		case "x-data":
			handleXData(msg)
		case "x-stop":
			handleXStop(msg)
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
			loadEnv()
			if config.RouterID == "" {
				fmt.Fprintln(os.Stderr, "ERROR: Missing SPOTFI_ROUTER_ID")
				os.Exit(1)
			}
			if config.Token == "" {
				fmt.Fprintln(os.Stderr, "ERROR: Missing SPOTFI_TOKEN")
				os.Exit(1)
			}
			if config.WsURL == "" {
				fmt.Fprintln(os.Stderr, "ERROR: Missing SPOTFI_WS_URL")
				os.Exit(1)
			}
			fmt.Fprintln(os.Stdout, "Configuration OK:")
			fmt.Fprintf(os.Stdout, "  Router ID: %s\n", config.RouterID)
			fmt.Fprintf(os.Stdout, "  WebSocket URL: %s\n", config.WsURL)
			fmt.Fprintf(os.Stdout, "  MAC Address: %s\n", config.Mac)
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
	loadEnv()
	if config.RouterID == "" {
		log.Fatal("Missing configuration: SPOTFI_ROUTER_ID not set")
	}

	// Heartbeat ticker
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		for range ticker.C {
			if wsConn != nil {
				sendJSON(map[string]interface{}{
					"type":    "metrics",
					"metrics": getMetrics(),
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

