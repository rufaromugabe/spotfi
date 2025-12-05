package rpc

import (
	"bytes"
	"encoding/json"
	"os/exec"
)

type RPCRequest struct {
	ID     string          `json:"id"`
	Path   string          `json:"path"`
	Method string          `json:"method"`
	Args   json.RawMessage `json:"args"`
}

// HandleRPC executes ubus command and sends response via callback
func HandleRPC(msg map[string]interface{}, sendFunc func(interface{}) error) {
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
	var stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr

	response := map[string]interface{}{
		"type": "rpc-result",
		"id":   req.ID,
	}

	err := cmd.Run()
	
	// Always try to parse output, even on error (ubus may return JSON with error details)
	var result interface{}
	if out.Len() > 0 {
		if err := json.Unmarshal(out.Bytes(), &result); err == nil {
			response["result"] = result
		} else {
			// If not JSON, return as string
			response["result"] = out.String()
		}
	} else {
		response["result"] = map[string]interface{}{}
	}

	if err != nil {
		response["status"] = "error"
		// Include the error message, but also include the result if available
		// This allows us to see stderr/stdout from commands like opkg
		response["error"] = err.Error()
		// If we have stderr, include it
		if stderr.Len() > 0 {
			response["stderr"] = stderr.String()
		}
	} else {
		response["status"] = "success"
	}

	sendFunc(response)
}
