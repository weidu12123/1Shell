// Package reporter posts collected snapshots to the 1Shell server.
package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/1shell/probe-agent/internal/collector"
	"github.com/1shell/probe-agent/internal/config"
)

// Reporter posts snapshots over HTTP using the existing probe report contract.
type Reporter struct {
	cfg    *config.Config
	client *http.Client
	ua     string
}

// New constructs a Reporter.
func New(cfg *config.Config, agentVersion string) *Reporter {
	return &Reporter{
		cfg:    cfg,
		client: &http.Client{Timeout: cfg.HTTPTimeout},
		ua:     "1shell-probe-agent/" + agentVersion,
	}
}

// Send marshals a snapshot to the report payload and POSTs it.
func (r *Reporter) Send(ctx context.Context, snap collector.Snapshot, agentVersion string) error {
	payload := buildPayload(r.cfg.HostID, agentVersion, snap)
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	url := r.cfg.ServerURL + "/api/agent/probe/report"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.cfg.AgentToken)
	req.Header.Set("User-Agent", r.ua)

	resp, err := r.client.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		preview, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("server %d: %s", resp.StatusCode, string(preview))
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}

// buildPayload aligns with the JSON contract defined in src/services/probe-agent.service.js.
func formatPlatform(platform collector.PlatformInfo) string {
	name := platform.PrettyName
	if name == "" {
		name = platform.DistroID
	}
	if name == "" {
		name = platform.OS
	}
	if platform.Arch != "" {
		name += " / " + platform.Arch
	}
	if platform.Kernel != "" {
		name += " / " + platform.Kernel
	}
	return name
}

func buildPayload(hostID, agentVersion string, snap collector.Snapshot) map[string]any {
	return map[string]any{
		"hostId":       hostID,
		"agentVersion": agentVersion,
		"timestamp":    snap.Timestamp.UTC().Format(time.RFC3339),
		"hostname":     snap.Hostname,
		"platform":     formatPlatform(snap.Platform),
		"platformInfo": map[string]any{
			"os":         snap.Platform.OS,
			"arch":       snap.Platform.Arch,
			"kernel":     snap.Platform.Kernel,
			"distroId":   snap.Platform.DistroID,
			"versionId":  snap.Platform.VersionID,
			"prettyName": snap.Platform.PrettyName,
		},
		"uptimeSec": snap.UptimeSec,
		"cpu": map[string]any{
			"usage": snap.CPU.Usage,
			"cores": snap.CPU.Cores,
		},
		"memory": map[string]any{
			"total": snap.Memory.Total,
			"used":  snap.Memory.Used,
			"usage": snap.Memory.Usage,
		},
		"swap": map[string]any{
			"total": snap.Swap.Total,
			"used":  snap.Swap.Used,
			"usage": snap.Swap.Usage,
		},
		"disk": map[string]any{
			"total": snap.Disk.Total,
			"used":  snap.Disk.Used,
			"usage": snap.Disk.Usage,
		},
		"load": map[string]any{
			"load1":  snap.Load.Load1,
			"load5":  snap.Load.Load5,
			"load15": snap.Load.Load15,
		},
		"network": map[string]any{
			"rxBytes": snap.Network.RxBytes,
			"txBytes": snap.Network.TxBytes,
			"rxBps":   snap.Network.RxBps,
			"txBps":   snap.Network.TxBps,
		},
		"processCount": snap.ProcessCount,
	}
}
