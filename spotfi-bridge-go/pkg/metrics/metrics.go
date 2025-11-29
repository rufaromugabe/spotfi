package metrics

import (
	"encoding/json"
	"fmt"
	"os/exec"
)

// GetMetrics collects system info and client list
func GetMetrics() map[string]interface{} {
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
