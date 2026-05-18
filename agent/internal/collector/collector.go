// Package collector samples host metrics from /proc and /sys.
//
// CPU and network rates use the dstatus-style 0.1s double-sample technique:
// take a snapshot, sleep, take another, diff. Other metrics (memory, load,
// disk usage, uptime) are single-shot reads.
package collector

import (
	"bufio"
	"errors"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Snapshot is the result of one collection pass.
type Snapshot struct {
	Timestamp    time.Time
	Hostname     string
	Platform     PlatformInfo
	UptimeSec    int64
	CPU          CPUInfo
	Memory       MemoryInfo
	Swap         MemoryInfo
	Load         LoadInfo
	Disk         DiskInfo
	Network      NetworkInfo
	ProcessCount int
}

type CPUInfo struct {
	Usage float64   // 0..100
	Cores []float64 // per-core usage 0..100
}

type MemoryInfo struct {
	Total uint64
	Used  uint64
	Usage float64 // 0..100
}

type LoadInfo struct {
	Load1  float64
	Load5  float64
	Load15 float64
}

type DiskInfo struct {
	Total uint64
	Used  uint64
	Usage float64 // 0..100 for /
}

type NetworkInfo struct {
	RxBytes uint64
	TxBytes uint64
	RxBps   float64
	TxBps   float64
}

type PlatformInfo struct {
	OS         string
	Arch       string
	Kernel     string
	DistroID   string
	VersionID  string
	PrettyName string
}

const sampleInterval = 100 * time.Millisecond

// Collect gathers a Snapshot. CPU and Net rates are computed across
// sampleInterval; memory / disk / load / uptime are single-shot.
func Collect() (Snapshot, error) {
	snap := Snapshot{Timestamp: time.Now().UTC()}

	if hn, err := os.Hostname(); err == nil {
		snap.Hostname = hn
	}
	snap.Platform = readPlatformInfo()

	if up, err := readUptime(); err == nil {
		snap.UptimeSec = up
	}

	cpu1, err := readCPUStat()
	if err != nil {
		return snap, err
	}
	net1, err := readNetDev()
	if err != nil {
		return snap, err
	}

	time.Sleep(sampleInterval)

	cpu2, err := readCPUStat()
	if err != nil {
		return snap, err
	}
	net2, err := readNetDev()
	if err != nil {
		return snap, err
	}

	snap.CPU = diffCPU(cpu1, cpu2)
	snap.Network = diffNet(net1, net2, sampleInterval)

	if mem, sw, err := readMemInfo(); err == nil {
		snap.Memory = mem
		snap.Swap = sw
	}
	if l, err := readLoadAvg(); err == nil {
		snap.Load = l
	}
	if d, err := readRootDisk(); err == nil {
		snap.Disk = d
	}
	if pc, err := readProcessCount(); err == nil {
		snap.ProcessCount = pc
	}

	return snap, nil
}

func readPlatformInfo() PlatformInfo {
	info := PlatformInfo{OS: runtime.GOOS, Arch: runtime.GOARCH}
	if release, err := readOSRelease(); err == nil {
		info.DistroID = release["ID"]
		info.VersionID = release["VERSION_ID"]
		info.PrettyName = release["PRETTY_NAME"]
	}
	var uts syscall.Utsname
	if syscall.Uname(&uts) == nil {
		info.Kernel = charsToString(uts.Release[:])
	}
	return info
}

func readOSRelease() (map[string]string, error) {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	values := map[string]string{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[key] = strings.Trim(strings.TrimSpace(value), "\"")
	}
	return values, scanner.Err()
}

func charsToString(chars []int8) string {
	buf := make([]byte, 0, len(chars))
	for _, c := range chars {
		if c == 0 {
			break
		}
		buf = append(buf, byte(c))
	}
	return string(buf)
}

// ────── /proc/stat ──────

type cpuTimes struct {
	total uint64
	idle  uint64
}

type cpuSnapshot struct {
	overall cpuTimes
	cores   []cpuTimes
}

func readCPUStat() (cpuSnapshot, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSnapshot{}, err
	}
	defer f.Close()

	var snap cpuSnapshot
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu") {
			break
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		var total uint64
		for _, f := range fields[1:] {
			v, _ := strconv.ParseUint(f, 10, 64)
			total += v
		}
		idle, _ := strconv.ParseUint(fields[4], 10, 64)
		t := cpuTimes{total: total, idle: idle}
		if fields[0] == "cpu" {
			snap.overall = t
		} else {
			snap.cores = append(snap.cores, t)
		}
	}
	return snap, scanner.Err()
}

func diffCPU(a, b cpuSnapshot) CPUInfo {
	info := CPUInfo{Usage: usageFromTimes(a.overall, b.overall)}
	n := len(a.cores)
	if len(b.cores) < n {
		n = len(b.cores)
	}
	info.Cores = make([]float64, 0, n)
	for i := 0; i < n; i++ {
		info.Cores = append(info.Cores, usageFromTimes(a.cores[i], b.cores[i]))
	}
	return info
}

func usageFromTimes(a, b cpuTimes) float64 {
	dt := int64(b.total) - int64(a.total)
	di := int64(b.idle) - int64(a.idle)
	if dt <= 0 {
		return 0
	}
	usage := float64(dt-di) * 100 / float64(dt)
	if usage < 0 {
		usage = 0
	}
	if usage > 100 {
		usage = 100
	}
	return roundTo(usage, 2)
}

// ────── /proc/net/dev ──────

type netSnapshot struct {
	rxBytes uint64
	txBytes uint64
	at      time.Time
}

func readNetDev() (netSnapshot, error) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return netSnapshot{}, err
	}
	defer f.Close()

	var rx, tx uint64
	scanner := bufio.NewScanner(f)
	// skip 2 header lines
	scanner.Scan()
	scanner.Scan()
	for scanner.Scan() {
		line := scanner.Text()
		colon := strings.Index(line, ":")
		if colon < 0 {
			continue
		}
		iface := strings.TrimSpace(line[:colon])
		if iface == "lo" || strings.HasPrefix(iface, "docker") || strings.HasPrefix(iface, "br-") || strings.HasPrefix(iface, "veth") {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return netSnapshot{rxBytes: rx, txBytes: tx, at: time.Now()}, scanner.Err()
}

func diffNet(a, b netSnapshot, fallback time.Duration) NetworkInfo {
	dur := b.at.Sub(a.at)
	if dur <= 0 {
		dur = fallback
	}
	seconds := dur.Seconds()
	info := NetworkInfo{RxBytes: b.rxBytes, TxBytes: b.txBytes}
	if seconds > 0 {
		if b.rxBytes >= a.rxBytes {
			info.RxBps = roundTo(float64(b.rxBytes-a.rxBytes)/seconds, 2)
		}
		if b.txBytes >= a.txBytes {
			info.TxBps = roundTo(float64(b.txBytes-a.txBytes)/seconds, 2)
		}
	}
	return info
}

// ────── memory ──────

func readMemInfo() (MemoryInfo, MemoryInfo, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return MemoryInfo{}, MemoryInfo{}, err
	}
	defer f.Close()

	values := map[string]uint64{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		v, _ := strconv.ParseUint(fields[1], 10, 64)
		values[key] = v * 1024 // /proc/meminfo reports kB
	}
	if err := scanner.Err(); err != nil {
		return MemoryInfo{}, MemoryInfo{}, err
	}

	memTotal := values["MemTotal"]
	memAvail := values["MemAvailable"]
	if memAvail == 0 {
		memAvail = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	mem := MemoryInfo{Total: memTotal}
	if memTotal > memAvail {
		mem.Used = memTotal - memAvail
	}
	if memTotal > 0 {
		mem.Usage = roundTo(float64(mem.Used)*100/float64(memTotal), 2)
	}

	swapTotal := values["SwapTotal"]
	swapFree := values["SwapFree"]
	sw := MemoryInfo{Total: swapTotal}
	if swapTotal > swapFree {
		sw.Used = swapTotal - swapFree
	}
	if swapTotal > 0 {
		sw.Usage = roundTo(float64(sw.Used)*100/float64(swapTotal), 2)
	}
	return mem, sw, nil
}

// ────── load ──────

func readLoadAvg() (LoadInfo, error) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return LoadInfo{}, err
	}
	fields := strings.Fields(string(b))
	if len(fields) < 3 {
		return LoadInfo{}, errors.New("loadavg malformed")
	}
	l1, _ := strconv.ParseFloat(fields[0], 64)
	l5, _ := strconv.ParseFloat(fields[1], 64)
	l15, _ := strconv.ParseFloat(fields[2], 64)
	return LoadInfo{Load1: roundTo(l1, 2), Load5: roundTo(l5, 2), Load15: roundTo(l15, 2)}, nil
}

// ────── uptime ──────

func readUptime() (int64, error) {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(b))
	if len(fields) < 1 {
		return 0, errors.New("uptime malformed")
	}
	v, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, err
	}
	return int64(v), nil
}

// ────── disk usage of / ──────

func readRootDisk() (DiskInfo, error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs("/", &s); err != nil {
		return DiskInfo{}, err
	}
	total := uint64(s.Blocks) * uint64(s.Bsize)
	free := uint64(s.Bavail) * uint64(s.Bsize)
	used := uint64(0)
	if total > free {
		used = total - free
	}
	usage := 0.0
	if total > 0 {
		usage = roundTo(float64(used)*100/float64(total), 2)
	}
	return DiskInfo{Total: total, Used: used, Usage: usage}, nil
}

// ────── process count ──────

func readProcessCount() (int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	count := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if name == "" || name[0] < '0' || name[0] > '9' {
			continue
		}
		count++
	}
	return count, nil
}

// ────── helpers ──────

func roundTo(v float64, digits int) float64 {
	mul := 1.0
	for i := 0; i < digits; i++ {
		mul *= 10
	}
	return float64(int64(v*mul+0.5)) / mul
}
