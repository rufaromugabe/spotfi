package session

import (
	"encoding/base64"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

type XSession struct {
	ID            string
	Cmd           *exec.Cmd
	Pty           *os.File
	Active        bool
	LastActivity  time.Time
	ResponseTopic string
}

type SessionManager struct {
	sessions map[string]*XSession
	mu       sync.Mutex
	sendFunc func(topic string, payload interface{}) error
}

func NewSessionManager(sendFunc func(topic string, payload interface{}) error) *SessionManager {
	sm := &SessionManager{
		sessions: make(map[string]*XSession),
		sendFunc: sendFunc,
	}
	// Start background sweeper for ghost sessions
	go sm.sweepGhostSessions()
	return sm
}

func (sm *SessionManager) sweepGhostSessions() {
	ticker := time.NewTicker(2 * time.Minute)
	for range ticker.C {
		sm.mu.Lock()
		now := time.Now()
		for id, sess := range sm.sessions {
			if sess.Active && now.Sub(sess.LastActivity) > 10*time.Minute {
				// Kill idle session
				sess.Active = false
				sess.Pty.Close()
				if sess.Cmd.Process != nil {
					sess.Cmd.Process.Kill()
				}
		delete(sm.sessions, id)
	}
}
		sm.mu.Unlock()
	}
}

func (sm *SessionManager) HandleStart(msg map[string]interface{}) {
	sessionID, _ := msg["sessionId"].(string)
	responseTopic, _ := msg["responseTopic"].(string)
	if sessionID == "" {
		return
	}

	// Close ALL existing sessions for this router to ensure only one session per router
	// This prevents multiple terminal sessions from being active simultaneously
	sm.mu.Lock()
	for id, sess := range sm.sessions {
		if sess.Active {
			sess.Active = false
			sess.Pty.Close()
			if sess.Cmd.Process != nil {
				sess.Cmd.Process.Kill()
			}
			delete(sm.sessions, id)
		}
	}
	sm.mu.Unlock()

	// Create command
	c := exec.Command("/bin/sh")
	// Set proper terminal environment variables to prevent echo issues
	c.Env = append(os.Environ(), 
		"TERM=xterm-256color",
		"HOME=/root",
		"PS1=$ ", // Simple prompt to avoid issues
	)

	// Start PTY
	f, err := pty.Start(c)
	if err != nil {
		sm.sendFunc(responseTopic, map[string]interface{}{
			"type":      "x-error",
			"sessionId": sessionID,
			"error":     err.Error(),
		})
		return
	}

	// Set window size (standard)
	pty.Setsize(f, &pty.Winsize{Rows: 24, Cols: 80})

	// Configure terminal to prevent character duplication
	// Send terminal configuration commands to ensure proper echo behavior
	go func() {
		// Wait for shell to be fully ready
		time.Sleep(400 * time.Millisecond)
		
		// Reset terminal to known good state
		// This clears any problematic terminal settings
		f.Write([]byte("stty sane\r"))
		time.Sleep(50 * time.Millisecond)
		
		// Configure for proper terminal behavior:
		// - Enable canonical mode (line editing works properly)
		// - Ensure echo is handled correctly by the shell
		// - Set proper terminal characteristics
		f.Write([]byte("stty icanon echo echoe echok\r"))
	}()

	sess := &XSession{
		ID:            sessionID,
		Cmd:           c,
		Pty:           f,
		Active:        true,
		LastActivity:  time.Now(),
		ResponseTopic: responseTopic,
	}

	sm.mu.Lock()
	sm.sessions[sessionID] = sess
	sm.mu.Unlock()

	// Ack
	sm.sendFunc(responseTopic, map[string]interface{}{
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
				sm.sendFunc(responseTopic, map[string]interface{}{
					"type":      "x-data",
					"sessionId": sessionID,
					"data":      dataB64,
				})
			}
		}
		// Cleanup when read fails (process exit)
		sm.HandleStop(map[string]interface{}{"sessionId": sessionID})
	}()
}

func (sm *SessionManager) HandleData(msg map[string]interface{}) {
	sessionID, _ := msg["sessionId"].(string)
	dataB64, _ := msg["data"].(string)

	sm.mu.Lock()
	sess, exists := sm.sessions[sessionID]
	if exists {
		sess.LastActivity = time.Now() // Heartbeat
	}
	sm.mu.Unlock()

	if !exists || !sess.Active {
		return
	}

	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err == nil {
		sess.Pty.Write(data)
	}
}

func (sm *SessionManager) HandleStop(msg map[string]interface{}) {
	sessionID, _ := msg["sessionId"].(string)

	sm.mu.Lock()
	defer sm.mu.Unlock()

	if sess, ok := sm.sessions[sessionID]; ok {
		sess.Active = false
		sess.Pty.Close()
		if sess.Cmd.Process != nil {
			sess.Cmd.Process.Kill()
		}
		delete(sm.sessions, sessionID)
	}
}
