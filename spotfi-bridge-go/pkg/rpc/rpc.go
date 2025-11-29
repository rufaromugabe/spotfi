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

	sendFunc(response)
}
