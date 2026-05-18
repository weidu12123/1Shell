// Package config loads runtime configuration from environment variables.
//
// Convention: in production, systemd loads /etc/1shell-probe-agent.env via
// EnvironmentFile= which sets HOST_ID, SERVER_URL, AGENT_TOKEN, INTERVAL_SEC.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultIntervalSec = 30
	MinIntervalSec     = 10
	MaxIntervalSec     = 3600
)

// Config holds runtime parameters.
type Config struct {
	HostID     string
	ServerURL  string
	AgentToken string
	Interval   time.Duration
	HTTPTimeout time.Duration
}

// Load reads the config from the process environment.
func Load() (*Config, error) {
	hostID := strings.TrimSpace(os.Getenv("HOST_ID"))
	serverURL := strings.TrimRightFunc(strings.TrimSpace(os.Getenv("SERVER_URL")), func(r rune) bool { return r == '/' })
	agentToken := strings.TrimSpace(os.Getenv("AGENT_TOKEN"))

	missing := make([]string, 0, 3)
	if hostID == "" {
		missing = append(missing, "HOST_ID")
	}
	if serverURL == "" {
		missing = append(missing, "SERVER_URL")
	}
	if agentToken == "" {
		missing = append(missing, "AGENT_TOKEN")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}

	intervalSec := DefaultIntervalSec
	if v := strings.TrimSpace(os.Getenv("INTERVAL_SEC")); v != "" {
		parsed, err := strconv.Atoi(v)
		if err != nil {
			return nil, fmt.Errorf("INTERVAL_SEC invalid: %w", err)
		}
		if parsed < MinIntervalSec || parsed > MaxIntervalSec {
			return nil, errors.New("INTERVAL_SEC out of range [10,3600]")
		}
		intervalSec = parsed
	}

	httpTimeout := 15 * time.Second
	if v := strings.TrimSpace(os.Getenv("HTTP_TIMEOUT_SEC")); v != "" {
		parsed, err := strconv.Atoi(v)
		if err == nil && parsed >= 1 && parsed <= 120 {
			httpTimeout = time.Duration(parsed) * time.Second
		}
	}

	return &Config{
		HostID:      hostID,
		ServerURL:   serverURL,
		AgentToken:  agentToken,
		Interval:    time.Duration(intervalSec) * time.Second,
		HTTPTimeout: httpTimeout,
	}, nil
}
