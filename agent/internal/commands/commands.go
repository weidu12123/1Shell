package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/1shell/probe-agent/internal/config"
	"github.com/1shell/probe-agent/internal/fileops"
)

type Runner struct {
	cfg    *config.Config
	client *http.Client
	log    *log.Logger
}

type commandEnvelope struct {
	OK      bool     `json:"ok"`
	Command *command `json:"command"`
}

type command struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type commandResult struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

func New(cfg *config.Config, logger *log.Logger) *Runner {
	return &Runner{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.HTTPTimeout},
		log:    logger,
	}
}

func (r *Runner) Loop(ctx context.Context) {
	ticker := time.NewTicker(1200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.pollOnce(ctx); err != nil {
				r.log.Printf("command poll error: %v", err)
			}
		}
	}
}

func (r *Runner) pollOnce(ctx context.Context) error {
	cmd, err := r.nextCommand(ctx)
	if err != nil || cmd == nil {
		return err
	}
	result := r.execute(cmd)
	return r.postResult(ctx, cmd.ID, result)
}

func (r *Runner) nextCommand(ctx context.Context) (*command, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.cfg.ServerURL+"/api/agent/probe/commands/next", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.cfg.AgentToken)
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode >= 400 {
		preview, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("server %d: %s", resp.StatusCode, string(preview))
	}
	var envelope commandEnvelope
	if err := json.NewDecoder(resp.Body).Decode(&envelope); err != nil {
		return nil, err
	}
	return envelope.Command, nil
}

func (r *Runner) execute(cmd *command) commandResult {
	switch cmd.Type {
	case "file.listDir":
		var opt fileops.ListDirOptions
		if err := json.Unmarshal(cmd.Payload, &opt); err != nil {
			return commandResult{OK: false, Error: err.Error()}
		}
		result, err := fileops.ListDir(opt)
		if err != nil {
			return commandResult{OK: false, Error: err.Error()}
		}
		return commandResult{OK: true, Result: result}
	default:
		return commandResult{OK: false, Error: "unsupported command type: " + cmd.Type}
	}
}

func (r *Runner) postResult(ctx context.Context, commandID string, result commandResult) error {
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.cfg.ServerURL+"/api/agent/probe/commands/"+commandID+"/result", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.cfg.AgentToken)
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		preview, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("result server %d: %s", resp.StatusCode, string(preview))
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}
