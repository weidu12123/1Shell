// Command agent runs the 1Shell probe agent loop.
//
// Lifecycle:
//   - load env config
//   - on each tick: collect a snapshot, post it, log on error
//   - shut down on SIGINT/SIGTERM
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/1shell/probe-agent/internal/collector"
	"github.com/1shell/probe-agent/internal/config"
	"github.com/1shell/probe-agent/internal/reporter"
)

// Version is set via -ldflags="-X main.Version=...".
var Version = "dev"

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	once := flag.Bool("once", false, "collect and report a single snapshot then exit (for testing)")
	flag.Parse()

	if *versionFlag {
		fmt.Println(Version)
		return
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config load: %v", err)
	}

	logger := log.New(os.Stderr, "[1shell-probe-agent] ", log.LstdFlags|log.LUTC)
	logger.Printf("starting v%s host=%s server=%s interval=%s", Version, cfg.HostID, cfg.ServerURL, cfg.Interval)

	rep := reporter.New(cfg, Version)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if *once {
		if err := tick(ctx, rep, logger); err != nil {
			logger.Printf("once tick error: %v", err)
			os.Exit(1)
		}
		return
	}

	// First tick immediately, then every cfg.Interval.
	if err := tick(ctx, rep, logger); err != nil {
		logger.Printf("first tick error: %v", err)
	}

	t := time.NewTicker(cfg.Interval)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Printf("shutdown")
			return
		case <-t.C:
			if err := tick(ctx, rep, logger); err != nil {
				logger.Printf("tick error: %v", err)
			}
		}
	}
}

func tick(ctx context.Context, rep *reporter.Reporter, logger *log.Logger) error {
	snap, err := collector.Collect()
	if err != nil {
		return fmt.Errorf("collect: %w", err)
	}
	sendCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := rep.Send(sendCtx, snap, Version); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	logger.Printf("reported cpu=%.2f%% mem=%.2f%% disk=%.2f%% rx=%.0fB/s tx=%.0fB/s",
		snap.CPU.Usage, snap.Memory.Usage, snap.Disk.Usage, snap.Network.RxBps, snap.Network.TxBps)
	return nil
}
