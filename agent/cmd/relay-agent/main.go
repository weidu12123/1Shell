package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

var Version = "dev"

const (
	defaultListenAddr = ":3301"
	defaultStateFile  = "/var/lib/1shell-probe-relay/state.json"
	defaultTTL        = 15 * time.Minute
	staleAfter        = 3 * time.Minute
	trustMinReports   = 1
	trustResetGap     = 6 * time.Minute
	sampleRetention   = 7 * 24 * time.Hour
)

type Config struct {
	ListenAddr   string
	SyncToken    string
	StateFile    string
	AgentDistDir string
}

type InstallToken struct {
	HostID     string    `json:"hostId"`
	ExpiresAt  time.Time `json:"expiresAt"`
	ConsumedAt time.Time `json:"consumedAt,omitempty"`
}

type Agent struct {
	HostID             string    `json:"hostId"`
	AgentID            string    `json:"agentId"`
	TokenHash          string    `json:"tokenHash"`
	AgentVersion       string    `json:"agentVersion,omitempty"`
	LastSeenAt         time.Time `json:"lastSeenAt"`
	InstalledAt        time.Time `json:"installedAt"`
	ConsecutiveOKCount int       `json:"consecutiveOkCount"`
	FirstHealthyAt     time.Time `json:"firstHealthyAt,omitempty"`
}

type LatestPayload struct {
	Payload    json.RawMessage `json:"payload"`
	ReportedAt time.Time       `json:"reportedAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

type StoredSample struct {
	HostID     string          `json:"hostId"`
	Payload    json.RawMessage `json:"payload"`
	ReportedAt time.Time       `json:"reportedAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

type State struct {
	InstallTokens map[string]InstallToken  `json:"installTokens"`
	Agents        map[string]Agent         `json:"agents"`
	Latest        map[string]LatestPayload `json:"latest"`
	Samples       []StoredSample           `json:"samples"`
}

type Server struct {
	cfg   Config
	log   *log.Logger
	mu    sync.Mutex
	state State
}

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *versionFlag {
		fmt.Println(Version)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	srv := &Server{cfg: cfg, log: log.New(os.Stderr, "[1shell-probe-relay] ", log.LstdFlags|log.LUTC)}
	if err := srv.loadState(); err != nil {
		srv.log.Fatalf("load state: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", srv.handleHealth)
	mux.HandleFunc("/install.sh", srv.handleInstallScript)
	mux.HandleFunc("/agent-dist/", srv.handleAgentDist)
	mux.HandleFunc("/api/agent/probe/relay/install-token", srv.handleRelayInstallToken)
	mux.HandleFunc("/api/agent/probe/relay/forget-host", srv.handleRelayForgetHost)
	mux.HandleFunc("/api/agent/probe/relay-snapshot", srv.handleRelaySnapshot)
	mux.HandleFunc("/api/agent/probe/register", srv.handleRegister)
	mux.HandleFunc("/api/agent/probe/report", srv.handleReport)
	mux.HandleFunc("/api/agent/probe/commands/next", srv.handleCommandNext)
	mux.HandleFunc("/api/agent/probe/commands/", srv.handleCommandResult)

	httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: mux}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	srv.log.Printf("starting v%s listen=%s state=%s", Version, cfg.ListenAddr, cfg.StateFile)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		srv.log.Fatalf("listen: %v", err)
	}
}

func loadConfig() (Config, error) {
	listenAddr := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if listenAddr == "" {
		listenAddr = defaultListenAddr
	}
	syncToken := strings.TrimSpace(os.Getenv("SYNC_TOKEN"))
	if syncToken == "" {
		return Config{}, errors.New("missing SYNC_TOKEN")
	}
	stateFile := strings.TrimSpace(os.Getenv("STATE_FILE"))
	if stateFile == "" {
		stateFile = defaultStateFile
	}
	agentDistDir := strings.TrimSpace(os.Getenv("AGENT_DIST_DIR"))
	if agentDistDir == "" {
		agentDistDir = "/opt/1shell/probe-relay"
	}
	return Config{ListenAddr: listenAddr, SyncToken: syncToken, StateFile: stateFile, AgentDistDir: agentDistDir}, nil
}

func (s *Server) loadState() error {
	s.state = State{
		InstallTokens: map[string]InstallToken{},
		Agents:        map[string]Agent{},
		Latest:        map[string]LatestPayload{},
		Samples:       []StoredSample{},
	}
	data, err := os.ReadFile(s.cfg.StateFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, &s.state); err != nil {
		return err
	}
	if s.state.InstallTokens == nil {
		s.state.InstallTokens = map[string]InstallToken{}
	}
	if s.state.Agents == nil {
		s.state.Agents = map[string]Agent{}
	}
	if s.state.Latest == nil {
		s.state.Latest = map[string]LatestPayload{}
	}
	if s.state.Samples == nil {
		s.state.Samples = []StoredSample{}
	}
	return nil
}

func (s *Server) saveStateLocked() error {
	s.pruneSamplesLocked(time.Now().UTC())
	if err := os.MkdirAll(filepath.Dir(s.cfg.StateFile), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.cfg.StateFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.cfg.StateFile)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "relay": true, "version": Version})
}

func (s *Server) handleInstallScript(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	http.ServeFile(w, r, filepath.Join(s.cfg.AgentDistDir, "install.sh"))
}

func (s *Server) handleAgentDist(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/agent-dist/")
	if name != "probe-agent-linux-amd64" && name != "probe-agent-linux-arm64" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	http.ServeFile(w, r, filepath.Join(s.cfg.AgentDistDir, name))
}

func (s *Server) handleRelayInstallToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.checkSyncAuth(r) {
		writeError(w, http.StatusUnauthorized, "Relay token 无效")
		return
	}
	var body struct {
		HostID string `json:"hostId"`
		TTLMS  int64  `json:"ttlMs"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hostID := strings.TrimSpace(body.HostID)
	if hostID == "" {
		writeError(w, http.StatusBadRequest, "hostId 不能为空")
		return
	}
	ttl := defaultTTL
	if body.TTLMS > 0 && body.TTLMS <= int64(24*time.Hour/time.Millisecond) {
		ttl = time.Duration(body.TTLMS) * time.Millisecond
	}
	token, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	expiresAt := time.Now().UTC().Add(ttl)
	s.mu.Lock()
	s.state.InstallTokens[hashToken(token)] = InstallToken{HostID: hostID, ExpiresAt: expiresAt}
	err = s.saveStateLocked()
	s.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hostId": hostID, "installToken": token, "expiresAt": expiresAt.Format(time.RFC3339)})
}

func (s *Server) handleRelaySnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.checkSyncAuth(r) {
		writeError(w, http.StatusUnauthorized, "Relay token 无效")
		return
	}
	since := parseOptionalTime(r.URL.Query().Get("since"))
	s.mu.Lock()
	probes := s.buildSnapshotLocked()
	samples := s.buildSamplesLocked(since)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "relay": true, "generatedAt": time.Now().UTC().Format(time.RFC3339), "probes": probes, "samples": samples})
}

func (s *Server) handleRelayForgetHost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.checkSyncAuth(r) {
		writeError(w, http.StatusUnauthorized, "Relay token 无效")
		return
	}
	var body struct {
		HostID string `json:"hostId"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hostID := strings.TrimSpace(body.HostID)
	if hostID == "" {
		writeError(w, http.StatusBadRequest, "hostId 不能为空")
		return
	}

	s.mu.Lock()
	removedAgents := 0
	for tokenHash, agent := range s.state.Agents {
		if agent.HostID == hostID {
			delete(s.state.Agents, tokenHash)
			removedAgents++
		}
	}
	_, hadLatest := s.state.Latest[hostID]
	delete(s.state.Latest, hostID)
	keptSamples := s.state.Samples[:0]
	removedSamples := 0
	for _, sample := range s.state.Samples {
		if sample.HostID == hostID {
			removedSamples++
			continue
		}
		keptSamples = append(keptSamples, sample)
	}
	s.state.Samples = keptSamples
	err := s.saveStateLocked()
	s.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hostId": hostID, "removedAgents": removedAgents, "removedLatest": hadLatest, "removedSamples": removedSamples})
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		HostID       string `json:"hostId"`
		InstallToken string `json:"installToken"`
		AgentVersion string `json:"agentVersion"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	hostID := strings.TrimSpace(body.HostID)
	tokenHash := hashToken(body.InstallToken)
	now := time.Now().UTC()
	agentToken, err := randomToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	agentID := "probe_agent_" + strings.ReplaceAll(randomID(), "=", "")

	s.mu.Lock()
	install, ok := s.state.InstallTokens[tokenHash]
	if !ok || install.HostID != hostID {
		s.mu.Unlock()
		writeError(w, http.StatusUnauthorized, "安装令牌无效")
		return
	}
	if !install.ConsumedAt.IsZero() {
		s.mu.Unlock()
		writeError(w, http.StatusUnauthorized, "安装令牌已使用")
		return
	}
	if install.ExpiresAt.Before(now) {
		s.mu.Unlock()
		writeError(w, http.StatusUnauthorized, "安装令牌已过期")
		return
	}
	install.ConsumedAt = now
	s.state.InstallTokens[tokenHash] = install
	agentTokenHash := hashToken(agentToken)
	for existingTokenHash, existingAgent := range s.state.Agents {
		if existingAgent.HostID == hostID {
			delete(s.state.Agents, existingTokenHash)
		}
	}
	s.state.Agents[agentTokenHash] = Agent{HostID: hostID, AgentID: agentID, TokenHash: agentTokenHash, AgentVersion: body.AgentVersion, LastSeenAt: now, InstalledAt: now}
	err = s.saveStateLocked()
	s.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hostId": hostID, "agentId": agentID, "agentToken": agentToken})
}

func (s *Server) handleReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	bearer := bearerToken(r)
	if bearer == "" {
		writeError(w, http.StatusUnauthorized, "agent token 无效")
		return
	}
	var body map[string]any
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC()
	tokenHash := hashToken(bearer)

	s.mu.Lock()
	agent, ok := s.state.Agents[tokenHash]
	if !ok {
		s.mu.Unlock()
		writeError(w, http.StatusUnauthorized, "agent token 无效")
		return
	}
	if bodyHostID, _ := body["hostId"].(string); bodyHostID != "" && bodyHostID != agent.HostID {
		s.mu.Unlock()
		writeError(w, http.StatusForbidden, "上报 hostId 与 agent 绑定主机不一致")
		return
	}
	body["hostId"] = agent.HostID
	if v, _ := body["agentVersion"].(string); strings.TrimSpace(v) != "" {
		agent.AgentVersion = v
	}
	previousLastSeen := agent.LastSeenAt
	agent.LastSeenAt = now
	if isPayloadHealthy(body) {
		if previousLastSeen.IsZero() || now.Sub(previousLastSeen) > trustResetGap || agent.ConsecutiveOKCount == 0 {
			agent.ConsecutiveOKCount = 1
			agent.FirstHealthyAt = now
		} else if agent.ConsecutiveOKCount < 10 {
			agent.ConsecutiveOKCount++
		}
	} else {
		agent.ConsecutiveOKCount = 0
		agent.FirstHealthyAt = time.Time{}
	}
	payload, err := json.Marshal(body)
	if err == nil {
		reportedAt := parseTime(fmt.Sprint(body["timestamp"]), now)
		s.state.Latest[agent.HostID] = LatestPayload{Payload: payload, ReportedAt: reportedAt, UpdatedAt: now}
		s.appendSampleLocked(StoredSample{HostID: agent.HostID, Payload: payload, ReportedAt: reportedAt, UpdatedAt: now})
	}
	s.state.Agents[tokenHash] = agent
	err = s.saveStateLocked()
	s.mu.Unlock()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hostId": agent.HostID, "reportedAt": now.Format(time.RFC3339)})
}

func (s *Server) handleCommandNext(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	bearer := bearerToken(r)
	if bearer == "" {
		writeError(w, http.StatusUnauthorized, "agent token 无效")
		return
	}
	s.mu.Lock()
	_, ok := s.state.Agents[hashToken(bearer)]
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusUnauthorized, "agent token 无效")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleCommandResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	bearer := bearerToken(r)
	if bearer == "" {
		writeError(w, http.StatusUnauthorized, "agent token 无效")
		return
	}
	s.mu.Lock()
	_, ok := s.state.Agents[hashToken(bearer)]
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusUnauthorized, "agent token 无效")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) checkSyncAuth(r *http.Request) bool {
	token := bearerToken(r)
	if token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.SyncToken)) == 1
}

func (s *Server) buildSnapshotLocked() []map[string]any {
	latestByHost := map[string]LatestPayload{}
	for hostID, latest := range s.state.Latest {
		latestByHost[hostID] = latest
	}

	agentsByHost := s.agentsByHostLocked()

	hostIDs := make([]string, 0, len(agentsByHost)+len(latestByHost))
	seen := map[string]bool{}
	for hostID := range agentsByHost {
		hostIDs = append(hostIDs, hostID)
		seen[hostID] = true
	}
	for hostID := range latestByHost {
		if !seen[hostID] {
			hostIDs = append(hostIDs, hostID)
		}
	}
	sort.Strings(hostIDs)

	probes := make([]map[string]any, 0, len(hostIDs))
	for _, hostID := range hostIDs {
		latest, hasLatest := latestByHost[hostID]
		agent, hasAgent := agentsByHost[hostID]
		if !hasAgent {
			agent = Agent{HostID: hostID, LastSeenAt: latest.UpdatedAt}
		}
		probes = append(probes, buildProbe(agent, latest, hasLatest))
	}
	return probes
}

func (s *Server) agentsByHostLocked() map[string]Agent {
	agentsByHost := map[string]Agent{}
	for _, agent := range s.state.Agents {
		current, ok := agentsByHost[agent.HostID]
		if !ok || agentRank(agent) >= agentRank(current) {
			agentsByHost[agent.HostID] = agent
		}
	}
	return agentsByHost
}

func (s *Server) buildSamplesLocked(since time.Time) []map[string]any {
	agentsByHost := s.agentsByHostLocked()
	items := make([]StoredSample, 0, len(s.state.Samples))
	for _, sample := range s.state.Samples {
		if !since.IsZero() && !sample.ReportedAt.After(since) {
			continue
		}
		items = append(items, sample)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ReportedAt.Equal(items[j].ReportedAt) {
			return items[i].HostID < items[j].HostID
		}
		return items[i].ReportedAt.Before(items[j].ReportedAt)
	})
	samples := make([]map[string]any, 0, len(items))
	for _, item := range items {
		agent := agentsByHost[item.HostID]
		if agent.HostID == "" {
			agent = Agent{HostID: item.HostID, LastSeenAt: item.UpdatedAt}
		}
		samples = append(samples, buildProbe(agent, LatestPayload{Payload: item.Payload, ReportedAt: item.ReportedAt, UpdatedAt: item.UpdatedAt}, true))
	}
	return samples
}

func (s *Server) appendSampleLocked(sample StoredSample) {
	if sample.HostID == "" || sample.ReportedAt.IsZero() || len(sample.Payload) == 0 {
		return
	}
	for i, existing := range s.state.Samples {
		if existing.HostID == sample.HostID && existing.ReportedAt.Equal(sample.ReportedAt) {
			s.state.Samples[i] = sample
			return
		}
	}
	s.state.Samples = append(s.state.Samples, sample)
}

func (s *Server) pruneSamplesLocked(now time.Time) {
	cutoff := now.Add(-sampleRetention)
	kept := s.state.Samples[:0]
	for _, sample := range s.state.Samples {
		if sample.ReportedAt.IsZero() || sample.ReportedAt.Before(cutoff) {
			continue
		}
		kept = append(kept, sample)
	}
	s.state.Samples = kept
}

func agentRank(agent Agent) int64 {
	rank := agent.LastSeenAt.UnixMilli()
	if agent.ConsecutiveOKCount >= trustMinReports {
		rank += 2_000_000_000_000_000
	} else if !agent.LastSeenAt.IsZero() && time.Since(agent.LastSeenAt) <= staleAfter {
		rank += 1_000_000_000_000_000
	}
	return rank
}

func buildProbe(agent Agent, latest LatestPayload, hasLatest bool) map[string]any {
	now := time.Now().UTC()
	lastSeen := agent.LastSeenAt
	if lastSeen.IsZero() && hasLatest {
		lastSeen = latest.UpdatedAt
	}
	recent := !lastSeen.IsZero() && now.Sub(lastSeen) <= staleAfter
	trusted := recent && agent.ConsecutiveOKCount >= trustMinReports
	status := "stale"
	if trusted {
		status = "online"
	} else if recent {
		status = "pending"
	}
	probe := map[string]any{
		"hostId":              agent.HostID,
		"name":                agent.HostID,
		"hostname":            agent.HostID,
		"platform":            nil,
		"platformInfo":        nil,
		"online":              recent,
		"stale":               !recent,
		"source":              "relay_agent",
		"relaySource":         true,
		"agentInstalled":      true,
		"agentOnline":         recent,
		"agentTrusted":        trusted,
		"agentConsecutiveOk":  agent.ConsecutiveOKCount,
		"agentVersion":        nullString(agent.AgentVersion),
		"agentLastSeenAt":     timeOrNil(lastSeen),
		"agentFirstHealthyAt": timeOrNil(agent.FirstHealthyAt),
		"agentStatus":         status,
		"checkedAt":           timeOrNil(lastSeen),
		"lastSuccessAt":       timeOrNil(lastSeen),
		"cpuUsage":            nil,
		"memoryUsage":         nil,
		"swapUsage":           nil,
		"diskUsage":           nil,
		"load1":               nil,
		"load5":               nil,
		"load15":              nil,
		"processCount":        nil,
		"bandwidthRxBps":      nil,
		"bandwidthTxBps":      nil,
		"networkRxBytes":      nil,
		"networkTxBytes":      nil,
	}
	if !hasLatest || len(latest.Payload) == 0 {
		return probe
	}
	var payload map[string]any
	if json.Unmarshal(latest.Payload, &payload) != nil {
		return probe
	}
	probe["hostname"] = stringValue(payload, "hostname", agent.HostID)
	probe["name"] = stringValue(payload, "name", agent.HostID)
	probe["platform"] = stringValue(payload, "platform", "")
	if probe["platform"] == "" {
		probe["platform"] = nil
	}
	if platformInfo, ok := payload["platformInfo"].(map[string]any); ok {
		probe["platformInfo"] = platformInfo
	}
	probe["checkedAt"] = latest.ReportedAt.Format(time.RFC3339)
	probe["lastSuccessAt"] = latest.ReportedAt.Format(time.RFC3339)
	probe["cpuUsage"] = nestedNumber(payload, "cpu", "usage")
	probe["memoryUsage"] = nestedNumber(payload, "memory", "usage")
	probe["swapUsage"] = nestedNumber(payload, "swap", "usage")
	probe["diskUsage"] = nestedNumber(payload, "disk", "usage")
	probe["load1"] = nestedNumber(payload, "load", "load1")
	probe["load5"] = nestedNumber(payload, "load", "load5")
	probe["load15"] = nestedNumber(payload, "load", "load15")
	probe["processCount"] = numberValue(payload, "processCount")
	probe["bandwidthRxBps"] = nestedNumber(payload, "network", "rxBps")
	probe["bandwidthTxBps"] = nestedNumber(payload, "network", "txBps")
	probe["networkRxBytes"] = nestedNumber(payload, "network", "rxBytes")
	probe["networkTxBytes"] = nestedNumber(payload, "network", "txBytes")
	return probe
}

func isPayloadHealthy(body map[string]any) bool {
	cpu := nestedNumber(body, "cpu", "usage")
	mem := nestedNumber(body, "memory", "usage")
	return cpu != nil && mem != nil
}

func nestedNumber(body map[string]any, key string, nested string) any {
	obj, ok := body[key].(map[string]any)
	if !ok {
		return nil
	}
	return numberValue(obj, nested)
}

func numberValue(body map[string]any, key string) any {
	v, ok := body[key]
	if !ok || v == nil {
		return nil
	}
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return n
	case int64:
		return n
	case json.Number:
		if f, err := n.Float64(); err == nil {
			return f
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			return f
		}
	}
	return nil
}

func stringValue(body map[string]any, key string, fallback string) string {
	if v, ok := body[key].(string); ok && strings.TrimSpace(v) != "" {
		return v
	}
	return fallback
}

func nullString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func timeOrNil(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value.Format(time.RFC3339)
}

func parseTime(value string, fallback time.Time) time.Time {
	if strings.TrimSpace(value) == "" || value == "<nil>" {
		return fallback
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t.UTC()
	}
	return fallback
}

func parseOptionalTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" || value == "<nil>" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return t.UTC()
	}
	if ms, err := strconv.ParseInt(value, 10, 64); err == nil && ms > 0 {
		return time.UnixMilli(ms).UTC()
	}
	return time.Time{}
}

func bearerToken(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func randomID() string {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return base64.RawURLEncoding.EncodeToString(buf)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}

func readJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 2*1024*1024))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return errors.New("请求体不能为空")
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	return dec.Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": message})
}
