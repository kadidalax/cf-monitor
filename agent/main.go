package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

var Version = "2.0.0"

const basicInfoRefreshInterval = 30 * time.Minute
const defaultPingIntervalSec = 60
const minReportInterval = 3 * time.Second

var (
	token             string
	serverURL         string
	reportInterval    int
	clientName        string
	reportMode        string
	reconnectInterval int
	pingInterval      int
	mountInclude      string
	mountExclude      string
	nicInclude        string
	nicExclude        string
)

type BasicInfo struct {
	CPUName        string `json:"cpu_name"`
	Virtualization string `json:"virtualization"`
	Arch           string `json:"arch"`
	CPUCores       int    `json:"cpu_cores"`
	OS             string `json:"os"`
	KernelVersion  string `json:"kernel_version"`
	GPUName        string `json:"gpu_name"`
	IPv4           string `json:"ipv4,omitempty"`
	IPv6           string `json:"ipv6,omitempty"`
	Region         string `json:"region,omitempty"`
	Version        string `json:"version"`
	Name           string `json:"name,omitempty"`
	MemTotal       int64  `json:"mem_total"`
	SwapTotal      int64  `json:"swap_total"`
	DiskTotal      int64  `json:"disk_total"`
	Uptime         int64  `json:"uptime"`
}

type Report struct {
	CPU            float64   `json:"cpu"`
	GPU            float64   `json:"gpu"`
	RAM            int64     `json:"ram"`
	RAMTotal       int64     `json:"ram_total"`
	Swap           int64     `json:"swap"`
	SwapTotal      int64     `json:"swap_total"`
	Load           float64   `json:"load"`
	Temp           float64   `json:"temp"`
	Disk           int64     `json:"disk"`
	DiskTotal      int64     `json:"disk_total"`
	NetIn          int64     `json:"net_in"`
	NetOut         int64     `json:"net_out"`
	NetTotalUp     int64     `json:"net_total_up"`
	NetTotalDown   int64     `json:"net_total_down"`
	ProcessCount   int       `json:"process_count"`
	Connections    int       `json:"connections"`
	ConnectionsUdp int       `json:"connections_udp"`
	Uptime         int64     `json:"uptime"`
	Version        string    `json:"version"`
	Name           string    `json:"name,omitempty"`
	ReportInterval int       `json:"report_interval,omitempty"`
	Timestamp      int64     `json:"timestamp,omitempty"`
	IPv4           string    `json:"ipv4,omitempty"`
	IPv6           string    `json:"ipv6,omitempty"`
	GPUs           []GPUInfo `json:"gpus,omitempty"`
}

type GPUInfo struct {
	DeviceIndex int     `json:"device_index"`
	DeviceName  string  `json:"device_name"`
	MemTotal    int64   `json:"mem_total"`
	MemUsed     int64   `json:"mem_used"`
	Utilization float64 `json:"utilization"`
	Temperature int     `json:"temperature"`
}

type PingTask struct {
	ID          int      `json:"id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Target      string   `json:"target"`
	IntervalSec int      `json:"interval_sec"`
	Clients     []string `json:"clients"`
	AllClients  bool     `json:"all_clients"`
}

type pingTasksResponse struct {
	Tasks       []PingTask `json:"tasks"`
	NextPollSec int        `json:"next_poll_sec"`
}

type PingResult struct {
	TaskID int     `json:"task_id"`
	Value  float64 `json:"value"`
}

type pingTaskScheduler struct {
	lastRunByTaskID map[int]time.Time
}

func newPingTaskScheduler() *pingTaskScheduler {
	return &pingTaskScheduler{lastRunByTaskID: make(map[int]time.Time)}
}

func pingTaskInterval(task PingTask) time.Duration {
	interval := task.IntervalSec
	if interval < 1 {
		interval = pingInterval
	}
	if interval < 1 {
		interval = defaultPingIntervalSec
	}
	return time.Duration(interval) * time.Second
}

func (s *pingTaskScheduler) dueTasks(tasks []PingTask, now time.Time) []PingTask {
	if s.lastRunByTaskID == nil {
		s.lastRunByTaskID = make(map[int]time.Time)
	}

	seen := make(map[int]struct{}, len(tasks))
	due := make([]PingTask, 0, len(tasks))
	for _, task := range tasks {
		if task.ID <= 0 {
			continue
		}
		seen[task.ID] = struct{}{}
		lastRun, ok := s.lastRunByTaskID[task.ID]
		if ok && now.Sub(lastRun) < pingTaskInterval(task) {
			continue
		}

		s.lastRunByTaskID[task.ID] = now
		due = append(due, task)
	}

	for taskID := range s.lastRunByTaskID {
		if _, ok := seen[taskID]; !ok {
			delete(s.lastRunByTaskID, taskID)
		}
	}

	return due
}

type reportEnvelope struct {
	Type string `json:"type"`
	Data Report `json:"data"`
}

type reportsEnvelope struct {
	Type    string   `json:"type"`
	Reports []Report `json:"reports"`
}

type serverMessage struct {
	Type              string `json:"type"`
	Timestamp         int64  `json:"timestamp,omitempty"`
	Mode              string `json:"mode,omitempty"`
	SampleIntervalSec int    `json:"sample_interval_sec,omitempty"`
	ReportIntervalSec int    `json:"report_interval_sec,omitempty"`
	ReportNow         bool   `json:"report_now,omitempty"`
	ViewerCount       int    `json:"viewer_count,omitempty"`
	ViewerTTLSec      int    `json:"viewer_ttl_sec,omitempty"`
}

type agentPolicy = serverMessage

type reportPreparer struct {
	lastNetUp       int64
	lastNetDown     int64
	lastTimestampMs int64
	ready           bool
}

type safeWebSocketConn struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func init() {
	flag.StringVar(&token, "token", "", "Agent token from the admin panel")
	flag.StringVar(&serverURL, "server", "", "Worker URL, for example https://cf-monitor.example.workers.dev")
	flag.IntVar(&reportInterval, "interval", 3, "Report interval in seconds")
	flag.StringVar(&clientName, "name", "", "Optional node name override")
	flag.StringVar(&reportMode, "mode", "websocket", "Report mode: websocket or http")
	flag.IntVar(&reconnectInterval, "reconnect-interval", 5, "WebSocket reconnect interval in seconds")
	flag.IntVar(&pingInterval, "ping-interval", defaultPingIntervalSec, "Ping task poll interval in seconds")
	flag.StringVar(&mountInclude, "mount-include", "", "Comma-separated mountpoint/device patterns to include in disk totals, for example /,/data,/dev/sd*")
	flag.StringVar(&mountExclude, "mount-exclude", "", "Comma-separated mountpoint/device patterns to exclude from disk totals, for example /boot,tmpfs,/run")
	flag.StringVar(&nicInclude, "nic-include", "", "Comma-separated network interface patterns to include in traffic totals, for example eth*,ens*")
	flag.StringVar(&nicExclude, "nic-exclude", "", "Comma-separated network interface patterns to exclude from traffic totals, for example lo,docker*,veth*")
}

func main() {
	flag.Parse()
	applyEnvDefaults()

	if reportInterval < int(minReportInterval/time.Second) {
		reportInterval = int(minReportInterval / time.Second)
	}
	if reconnectInterval < 1 {
		reconnectInterval = 1
	}
	if pingInterval < 1 {
		pingInterval = defaultPingIntervalSec
	}

	normalizedServer, err := normalizeServerURL(serverURL)
	if err != nil {
		log.Fatalf("invalid server URL: %v", err)
	}
	serverURL = normalizedServer
	reportMode = strings.ToLower(strings.TrimSpace(reportMode))

	if token == "" {
		log.Fatal("missing token: pass --token or set CF_MONITOR_TOKEN")
	}

	log.Printf("CF Monitor Agent v%s", Version)
	log.Printf("server: %s", serverURL)
	log.Printf("interval: %ds", reportInterval)
	log.Printf("mode: %s", reportMode)
	log.Printf("ping poll: every %ds", pingInterval)
	logFilter("disk include", mountInclude)
	logFilter("disk exclude", mountExclude)
	logFilter("network include", nicInclude)
	logFilter("network exclude", nicExclude)

	uploadBasicInfo()

	go runBasicInfoRefresher(basicInfoRefreshInterval, nil)

	// Start ping poller in background
	go runPingPoller()

	switch reportMode {
	case "websocket", "ws":
		runWebSocketReporter()
	case "http":
		runHTTPReporter()
	default:
		log.Fatalf("unsupported mode %q, expected websocket or http", reportMode)
	}
}

func applyEnvDefaults() {
	if token == "" {
		token = os.Getenv("CF_MONITOR_TOKEN")
	}
	if serverURL == "" {
		serverURL = os.Getenv("CF_MONITOR_SERVER")
	}
	if clientName == "" {
		clientName = os.Getenv("CF_MONITOR_NAME")
	}
	if mode := os.Getenv("CF_MONITOR_MODE"); reportMode == "websocket" && mode != "" {
		reportMode = mode
	}
	if mountInclude == "" {
		mountInclude = os.Getenv("CF_MONITOR_MOUNT_INCLUDE")
	}
	if mountExclude == "" {
		mountExclude = os.Getenv("CF_MONITOR_MOUNT_EXCLUDE")
	}
	if nicInclude == "" {
		nicInclude = os.Getenv("CF_MONITOR_NIC_INCLUDE")
	}
	if nicExclude == "" {
		nicExclude = os.Getenv("CF_MONITOR_NIC_EXCLUDE")
	}
}

func logFilter(label string, value string) {
	value = strings.TrimSpace(value)
	if value != "" {
		log.Printf("%s: %s", label, value)
	}
}

// ==================== GPU Detection ====================

func detectGPU() (string, []GPUInfo) {
	var names []string
	var details []GPUInfo

	// Try NVIDIA
	if nvidiaNames, nvidiaDetails := detectNvidiaGPU(); len(nvidiaDetails) > 0 {
		names = append(names, nvidiaNames...)
		details = append(details, nvidiaDetails...)
	}

	// Try AMD
	if amdNames, amdDetails := detectAMDGPU(); len(amdDetails) > 0 {
		names = append(names, amdNames...)
		details = append(details, amdDetails...)
	}

	return strings.Join(names, "; "), details
}

func parseNvidiaGPUOutput(output string) ([]string, []GPUInfo) {
	var names []string
	var details []GPUInfo

	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		parts := strings.SplitN(line, ",", 6)
		if len(parts) < 6 {
			continue
		}
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}

		index, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		name := parts[1]
		memTotal, err := strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			continue
		}
		memUsed, err := strconv.ParseInt(parts[3], 10, 64)
		if err != nil {
			continue
		}
		util, err := strconv.ParseFloat(parts[4], 64)
		if err != nil {
			continue
		}
		temp, err := strconv.Atoi(parts[5])
		if err != nil {
			continue
		}

		names = append(names, name)
		details = append(details, GPUInfo{
			DeviceIndex: index,
			DeviceName:  name,
			MemTotal:    memTotal * 1024 * 1024, // MiB to bytes
			MemUsed:     memUsed * 1024 * 1024,
			Utilization: util,
			Temperature: temp,
		})
	}

	return names, details
}

func detectNvidiaGPU() ([]string, []GPUInfo) {
	nvidiaSmi, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return nil, nil
	}

	// AGT-3: Add timeout to prevent indefinite blocking
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, nvidiaSmi,
		"--query-gpu=index,name,memory.total,memory.used,utilization.gpu,temperature.gpu",
		"--format=csv,noheader,nounits",
	)
	output, err := cmd.Output()
	if err != nil {
		log.Printf("nvidia-smi query failed: %v", err)
		return nil, nil
	}

	names, details := parseNvidiaGPUOutput(string(output))
	for _, detail := range details {
		log.Printf("GPU[%d] %s: util=%.1f%% mem=%d/%dMiB temp=%dC",
			detail.DeviceIndex,
			detail.DeviceName,
			detail.Utilization,
			detail.MemUsed/1024/1024,
			detail.MemTotal/1024/1024,
			detail.Temperature,
		)
	}

	return names, details
}

func parseNumberPrefix(value string) (float64, error) {
	fields := strings.Fields(strings.TrimSpace(value))
	if len(fields) == 0 {
		return 0, fmt.Errorf("empty number")
	}
	return strconv.ParseFloat(strings.TrimSuffix(fields[0], "%"), 64)
}

func parseIntPrefix(value string) (int64, error) {
	parsed, err := parseNumberPrefix(value)
	if err != nil {
		return 0, err
	}
	return int64(parsed), nil
}

func parseAMDGPUOutput(output string) ([]string, []GPUInfo) {
	gpus := map[int]*GPUInfo{}
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "GPU[") {
			continue
		}
		closeIdx := strings.Index(line, "]")
		colonIdx := strings.Index(line, ":")
		if closeIdx < 4 || colonIdx < 0 || colonIdx <= closeIdx {
			continue
		}
		index, err := strconv.Atoi(strings.TrimSpace(line[4:closeIdx]))
		if err != nil {
			continue
		}
		gpu := gpus[index]
		if gpu == nil {
			gpu = &GPUInfo{DeviceIndex: index, DeviceName: "AMD GPU"}
			gpus[index] = gpu
		}
		field := strings.TrimSpace(line[colonIdx+1:])
		fieldName, fieldValue, ok := strings.Cut(field, ":")
		if !ok {
			continue
		}
		fieldName = strings.TrimSpace(fieldName)
		fieldValue = strings.TrimSpace(fieldValue)
		switch {
		case strings.EqualFold(fieldName, "Card series"):
			if fieldValue != "" {
				gpu.DeviceName = fieldValue
			}
		case strings.EqualFold(fieldName, "GPU use (%)"):
			if value, err := parseNumberPrefix(fieldValue); err == nil {
				gpu.Utilization = value
			}
		case strings.EqualFold(fieldName, "VRAM Total Used Memory (B)"):
			if value, err := parseIntPrefix(fieldValue); err == nil {
				gpu.MemUsed = value
			}
		case strings.EqualFold(fieldName, "VRAM Total Memory (B)"):
			if value, err := parseIntPrefix(fieldValue); err == nil {
				gpu.MemTotal = value
			}
		case strings.HasPrefix(fieldName, "Temperature") && strings.Contains(fieldName, "(C)"):
			if value, err := parseNumberPrefix(fieldValue); err == nil {
				gpu.Temperature = int(value)
			}
		}
	}

	if len(gpus) == 0 {
		return []string{"AMD GPU"}, []GPUInfo{{DeviceIndex: 0, DeviceName: "AMD GPU"}}
	}

	indexes := make([]int, 0, len(gpus))
	for index := range gpus {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)

	names := make([]string, 0, len(indexes))
	details := make([]GPUInfo, 0, len(indexes))
	for _, index := range indexes {
		detail := *gpus[index]
		names = append(names, detail.DeviceName)
		details = append(details, detail)
	}
	return names, details
}

func detectAMDGPU() ([]string, []GPUInfo) {
	rocmSmi, err := exec.LookPath("rocm-smi")
	if err != nil {
		return nil, nil
	}

	// AGT-3: Add timeout to prevent indefinite blocking
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, rocmSmi, "--showproductname", "--showmeminfo", "vram", "--showuse", "--showtemp")
	output, err := cmd.Output()
	if err != nil {
		log.Printf("rocm-smi query failed: %v", err)
		return nil, nil
	}

	return parseAMDGPUOutput(string(output))
}

// ==================== Ping Execution ====================

func runPingPoller() {
	// AGT-2: Panic recovery to prevent silent goroutine death
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC in runPingPoller (restarting): %v", r)
			time.Sleep(5 * time.Second)
			go runPingPoller() // Restart the goroutine
		}
	}()

	scheduler := newPingTaskScheduler()
	for {
		tasks, nextPollSec := executePingTasks(scheduler, time.Now())
		time.Sleep(pingPollDelay(tasks, pingInterval, nextPollSec))
	}
}

func executePingTasks(scheduler *pingTaskScheduler, now time.Time) ([]PingTask, int) {
	endpoint := serverURL + "/api/clients/ping/tasks?format=v2"
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		log.Printf("ping tasks request error: %v", err)
		return nil, 0
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("ping tasks fetch failed: %v", err)
		return nil, 0
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		log.Printf("ping tasks HTTP %d", resp.StatusCode)
		return nil, 0
	}

	tasks, nextPollSec, err := decodePingTasksResponse(resp.Body)
	if err != nil {
		log.Printf("ping tasks parse error: %v", err)
		return nil, 0
	}

	if len(tasks) == 0 {
		return tasks, nextPollSec
	}

	dueTasks := scheduler.dueTasks(tasks, now)
	if len(dueTasks) == 0 {
		return tasks, nextPollSec
	}

	log.Printf("executing %d ping task(s)", len(dueTasks))
	var results []PingResult

	for _, task := range dueTasks {
		var value float64

		switch strings.ToLower(task.Type) {
		case "icmp":
			value = executeICMPPing(task.Target)
		case "tcp":
			value = executeTCPPing(task.Target)
		case "http", "https":
			value = executeHTTPPing(task.Target)
		default:
			value = executeTCPPing(task.Target)
		}

		results = append(results, PingResult{
			TaskID: task.ID,
			Value:  value,
		})
	}

	if len(results) > 0 {
		reportPingResults(results)
	}
	return tasks, nextPollSec
}

func decodePingTasksResponse(body io.Reader) ([]PingTask, int, error) {
	var raw json.RawMessage
	if err := json.NewDecoder(body).Decode(&raw); err != nil {
		return nil, 0, err
	}

	var tasks []PingTask
	if err := json.Unmarshal(raw, &tasks); err == nil {
		return tasks, 0, nil
	}

	var envelope pingTasksResponse
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, 0, err
	}
	if envelope.Tasks == nil {
		envelope.Tasks = []PingTask{}
	}
	return envelope.Tasks, envelope.NextPollSec, nil
}

func pingPollDelay(tasks []PingTask, configuredIntervalSec int, suggestedNextPollSec int) time.Duration {
	intervalSec := configuredIntervalSec
	if intervalSec < 1 {
		intervalSec = defaultPingIntervalSec
	}
	if suggestedNextPollSec > 0 {
		intervalSec = suggestedNextPollSec
	}
	for _, task := range tasks {
		taskInterval := task.IntervalSec
		if taskInterval < 1 {
			taskInterval = intervalSec
		}
		if taskInterval > 0 && taskInterval < intervalSec {
			intervalSec = taskInterval
		}
	}
	if intervalSec < 1 {
		intervalSec = defaultPingIntervalSec
	}
	return time.Duration(intervalSec) * time.Second
}

// AGT-6: Validate ping target to prevent SSRF to private/loopback addresses
func isPrivateOrLoopbackIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	// Check RFC1918 private ranges
	privateRanges := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"169.254.0.0/16", // link-local
		"127.0.0.0/8",    // loopback
		"::1/128",        // IPv6 loopback
		"fc00::/7",       // IPv6 unique local
		"fe80::/10",      // IPv6 link-local
	}
	for _, cidr := range privateRanges {
		_, ipnet, err := net.ParseCIDR(cidr)
		if err == nil && ipnet.Contains(ip) {
			return true
		}
	}
	return false
}

func validatePingTarget(target string) error {
	// Extract hostname from target (remove port if present)
	host := target
	if strings.Contains(target, ":") {
		var err error
		host, _, err = net.SplitHostPort(target)
		if err != nil {
			// If split fails, treat entire target as host
			host = target
		}
	}

	// Resolve hostname to IP
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("hostname resolution failed: %w", err)
	}

	// Check if any resolved IP is private/loopback
	for _, ip := range ips {
		if isPrivateOrLoopbackIP(ip) {
			return fmt.Errorf("target resolves to private/loopback IP: %s", ip)
		}
	}

	return nil
}

func normalizePingTarget(target string) (string, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		return "", fmt.Errorf("ping target is empty")
	}
	if strings.ContainsAny(target, "\x00\r\n") {
		return "", fmt.Errorf("ping target contains control characters")
	}
	if strings.HasPrefix(target, "-") || (runtime.GOOS == "windows" && strings.HasPrefix(target, "/")) {
		return "", fmt.Errorf("ping target must not start with an option prefix")
	}
	return target, nil
}

func executeICMPPing(target string) float64 {
	target, err := normalizePingTarget(target)
	if err != nil {
		log.Printf("icmp ping target rejected: %v", err)
		return -1
	}

	// AGT-6: Validate target before execution (optional - can be disabled for internal monitoring)
	// Uncomment to enforce SSRF protection:
	// if err := validatePingTarget(target); err != nil {
	// 	log.Printf("ping target validation failed: %v", err)
	// 	return -1
	// }

	start := time.Now()

	// Use system ping command for cross-platform ICMP
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("ping", "-n", "1", "-w", "2000", target)
	} else {
		cmd = exec.Command("ping", "-c", "1", "-W", "2", "--", target)
	}

	err := cmd.Run()
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		return -1
	}
	return float64(elapsed)
}

func executeTCPPing(target string) float64 {
	target, err := normalizePingTarget(target)
	if err != nil {
		log.Printf("tcp ping target rejected: %v", err)
		return -1
	}

	// AGT-6: Validate target before execution (optional)
	// Uncomment to enforce SSRF protection:
	// if err := validatePingTarget(target); err != nil {
	// 	log.Printf("tcp ping target validation failed: %v", err)
	// 	return -1
	// }

	// Ensure target has port
	if !strings.Contains(target, ":") {
		target = target + ":80"
	}

	start := time.Now()
	conn, err := net.DialTimeout("tcp", target, 3*time.Second)
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		return -1
	}
	conn.Close()
	return float64(elapsed)
}

func executeHTTPPing(target string) float64 {
	var err error
	target, err = normalizePingTarget(target)
	if err != nil {
		log.Printf("http ping target rejected: %v", err)
		return -1
	}

	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = "https://" + target
	}

	start := time.Now()
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(target)
	elapsed := time.Since(start).Milliseconds()

	if err != nil {
		return -1
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return -1
	}
	return float64(elapsed)
}

func reportPingResults(results []PingResult) {
	endpoint := serverURL + "/api/clients/ping/result"
	body, err := json.Marshal(results)
	if err != nil {
		return
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("ping result report failed: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		log.Printf("reported %d ping result(s)", len(results))
	} else {
		log.Printf("ping result report HTTP %d", resp.StatusCode)
	}
}

// ==================== Original Functions (Enhanced) ====================

func uploadBasicInfo() {
	uploadBasicInfoWithTimeout(15 * time.Second)
}

func uploadBasicInfoWithTimeout(timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	uploadBasicInfoWithContext(ctx)
}

func uploadBasicInfoWithContext(ctx context.Context) {
	info := getBasicInfo()
	endpoint := serverURL + "/api/clients/uploadBasicInfo"
	if err := postJSONWithContext(ctx, endpoint, info, token); err != nil {
		log.Printf("basic info upload failed: %v", err)
		return
	}
	log.Println("basic info uploaded")
}

func runBasicInfoRefresher(interval time.Duration, stop <-chan struct{}) {
	// AGT-2: Panic recovery to prevent silent goroutine death
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC in runBasicInfoRefresher (restarting): %v", r)
			time.Sleep(5 * time.Second)
			go runBasicInfoRefresher(interval, stop) // Restart the goroutine
		}
	}()

	if interval <= 0 {
		interval = basicInfoRefreshInterval
	}
	parentCtx, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	if stop != nil {
		go func() {
			select {
			case <-stop:
				cancelParent()
			case <-parentCtx.Done():
			}
		}()
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(parentCtx, 15*time.Second)
			uploadBasicInfoWithContext(ctx)
			cancel()
		case <-parentCtx.Done():
			return
		}
	}
}

func runHTTPReporter() {
	log.Println("HTTP reporter started")
	preparer := &reportPreparer{}
	currentSampleInterval := normalizeReportDuration(time.Duration(reportInterval) * time.Second)
	currentUploadInterval := currentSampleInterval
	nextUploadAt := time.Now()
	var pending []Report

	// AGT-4: Cache policy fetch to reduce API load
	// Only fetch policy every 10 cycles or when sample interval is short
	policyFetchCounter := 0
	const policyFetchInterval = 10 // Fetch policy every 10 sample cycles

	for {
		// AGT-4: Conditional policy fetch
		shouldFetchPolicy := policyFetchCounter == 0 ||
			(currentSampleInterval < 30*time.Second && policyFetchCounter%(policyFetchInterval/3) == 0)

		if shouldFetchPolicy {
			if policy, err := fetchAgentPolicy(); err == nil {
				nextSampleInterval, nextUploadInterval := policyDurations(policy, currentSampleInterval)
				if nextSampleInterval != currentSampleInterval || nextUploadInterval != currentUploadInterval {
					currentSampleInterval = nextSampleInterval
					currentUploadInterval = nextUploadInterval
					reportInterval = int(currentSampleInterval / time.Second)
					nextUploadAt = time.Now().Add(currentUploadInterval)
					log.Printf("HTTP policy: mode=%s sample=%s upload=%s viewers=%d ttl=%ds",
						policy.Mode,
						currentSampleInterval,
						currentUploadInterval,
						policy.ViewerCount,
						policy.ViewerTTLSec,
					)
				}
				if policy.ReportNow {
					pending = append(pending, preparer.prepareForInterval(currentSampleInterval))
					sendHTTPReports(pending)
					pending = nil
				nextUploadAt = time.Now().Add(currentUploadInterval)
			}
		} else {
			log.Printf("HTTP policy fetch failed: %v", err)
		}

		// AGT-4: Increment policy fetch counter
		policyFetchCounter = (policyFetchCounter + 1) % (policyFetchInterval * 2)

		pending = append(pending, preparer.prepareForInterval(currentSampleInterval))
		if currentUploadInterval <= currentSampleInterval || !time.Now().Before(nextUploadAt) {
			sendHTTPReports(pending)
			pending = nil
			nextUploadAt = time.Now().Add(currentUploadInterval)
		}
		time.Sleep(currentSampleInterval)
	}
}

func runWebSocketReporter() {
	endpoint, err := webSocketEndpoint(serverURL, token)
	if err != nil {
		log.Fatalf("invalid WebSocket endpoint: %v", err)
	}

	log.Printf("WebSocket reporter started: %s", endpoint)
	preparer := &reportPreparer{}

	// AGT-5: Exponential backoff for reconnection
	reconnectAttempts := 0
	const maxReconnectAttempts = 10

	for {
		conn, err := connectWebSocket(endpoint, token)
		if err != nil {
			log.Printf("WebSocket connect failed: %v", err)

			// Calculate backoff delay: min(reconnectInterval * 2^attempts, 300s)
			backoffFactor := 1 << uint(reconnectAttempts) // 2^attempts
			if backoffFactor > 60 {
				backoffFactor = 60 // Cap multiplier at 60x
			}
			delay := time.Duration(reconnectInterval) * time.Second * time.Duration(backoffFactor)
			maxDelay := 300 * time.Second
			if delay > maxDelay {
				delay = maxDelay
			}

			if reconnectAttempts < maxReconnectAttempts {
				reconnectAttempts++
			}

			log.Printf("reconnecting in %v (attempt %d)", delay, reconnectAttempts)
			time.Sleep(delay)
			continue
		}

		// Reset backoff on successful connection
		reconnectAttempts = 0
		log.Println("WebSocket connected")

		_ = runWebSocketSession(
			conn,
			preparer,
			time.Duration(reportInterval)*time.Second,
			30*time.Second,
		)

		// Normal reconnect after graceful disconnect
		log.Printf("reconnecting in %ds", reconnectInterval)
		time.Sleep(time.Duration(reconnectInterval) * time.Second)
	}
}

func runWebSocketSession(
	conn *safeWebSocketConn,
	preparer *reportPreparer,
	dataInterval time.Duration,
	heartbeatInterval time.Duration,
) error {
	defer conn.Close()

	done := make(chan error, 1)
	policies := make(chan serverMessage, 8)
	go readWebSocketMessages(conn, done, policies)

	currentInterval := normalizeReportDuration(dataInterval)
	currentUploadInterval := currentInterval
	var pending []Report

	pending = append(pending, preparer.prepareForInterval(currentInterval))
	if err := sendWebSocketReports(conn, pending); err != nil {
		log.Printf("WebSocket initial report failed: %v", err)
		return err
	}
	pending = nil

	sampleTimer := time.NewTimer(currentInterval)
	defer sampleTimer.Stop()
	uploadTimer := time.NewTimer(currentUploadInterval)
	defer uploadTimer.Stop()
	heartbeatTicker := time.NewTicker(heartbeatInterval)
	defer heartbeatTicker.Stop()

	for {
		select {
		case <-sampleTimer.C:
			pending = append(pending, preparer.prepareForInterval(currentInterval))
			if currentUploadInterval <= currentInterval {
				if err := sendWebSocketReports(conn, pending); err != nil {
					log.Printf("WebSocket report failed: %v", err)
					return err
				}
				pending = nil
				resetTimer(uploadTimer, currentUploadInterval)
			}
			resetTimer(sampleTimer, currentInterval)
		case <-uploadTimer.C:
			if len(pending) > 0 {
				if err := sendWebSocketReports(conn, pending); err != nil {
					log.Printf("WebSocket report batch failed: %v", err)
					return err
				}
				pending = nil
			}
			resetTimer(uploadTimer, currentUploadInterval)
		case policy := <-policies:
			if policy.Type != "policy" {
				continue
			}
			nextInterval, nextUploadInterval := policyDurations(policy, currentInterval)
			if nextInterval != currentInterval || nextUploadInterval != currentUploadInterval {
				currentInterval = nextInterval
				currentUploadInterval = nextUploadInterval
				reportInterval = int(currentInterval / time.Second)
				log.Printf("WebSocket policy: mode=%s sample=%s upload=%s viewers=%d ttl=%ds",
					policy.Mode,
					currentInterval,
					currentUploadInterval,
					policy.ViewerCount,
					policy.ViewerTTLSec,
				)
			}
			if policy.ReportNow {
				pending = append(pending, preparer.prepareForInterval(currentInterval))
				if err := sendWebSocketReports(conn, pending); err != nil {
					log.Printf("WebSocket immediate report failed: %v", err)
					return err
				}
				pending = nil
			}
			resetTimer(sampleTimer, currentInterval)
			resetTimer(uploadTimer, currentUploadInterval)
		case <-heartbeatTicker.C:
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				log.Printf("WebSocket heartbeat failed: %v", err)
				return err
			}
		case err := <-done:
			if err != nil {
				log.Printf("WebSocket read stopped: %v", err)
				return err
			}
			return nil
		}
	}
}

func policyDurations(policy agentPolicy, fallback time.Duration) (time.Duration, time.Duration) {
	reportSec := policy.ReportIntervalSec
	if reportSec < 1 {
		reportSec = intervalSeconds(fallback)
	}
	sampleSec := policy.SampleIntervalSec
	if sampleSec < 1 {
		sampleSec = reportSec
	}
	return normalizeReportDuration(time.Duration(sampleSec) * time.Second),
		normalizeReportDuration(time.Duration(reportSec) * time.Second)
}

func normalizeReportDuration(interval time.Duration) time.Duration {
	if interval < minReportInterval {
		return minReportInterval
	}
	return interval
}

func intervalSeconds(interval time.Duration) int {
	return int(normalizeReportDuration(interval) / time.Second)
}

func resetTimer(timer *time.Timer, interval time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(normalizeReportDuration(interval))
}

func outboundIP(network, address string) string {
	conn, err := net.DialTimeout(network, address, time.Second)
	if err != nil {
		return ""
	}
	defer conn.Close()

	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok && addr.IP != nil {
		return addr.IP.String()
	}
	return ""
}

func fallbackInterfaceIPs() (string, string) {
	var ipv4, ipv6 string
	interfaces, err := net.Interfaces()
	if err != nil {
		return "", ""
	}

	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip4 := ip.To4(); ip4 != nil {
				if ipv4 == "" {
					ipv4 = ip4.String()
				}
				continue
			}
			if ip.To16() != nil && ipv6 == "" {
				ipv6 = ip.String()
			}
		}
	}

	return ipv4, ipv6
}

func localIPAddresses() (string, string) {
	ipv4 := outboundIP("udp4", "1.1.1.1:80")
	ipv6 := outboundIP("udp6", "[2606:4700:4700::1111]:80")
	if ipv4 != "" && ipv6 != "" {
		return ipv4, ipv6
	}

	fallbackIPv4, fallbackIPv6 := fallbackInterfaceIPs()
	if ipv4 == "" {
		ipv4 = fallbackIPv4
	}
	if ipv6 == "" {
		ipv6 = fallbackIPv6
	}
	return ipv4, ipv6
}

func getBasicInfo() BasicInfo {
	info := BasicInfo{
		Arch:    runtime.GOARCH,
		OS:      runtime.GOOS,
		Version: Version,
	}
	if clientName != "" {
		info.Name = clientName
	}
	info.IPv4, info.IPv6 = localIPAddresses()

	if hostInfo, err := host.Info(); err == nil {
		info.KernelVersion = hostInfo.KernelVersion
		info.OS = strings.TrimSpace(hostInfo.Platform + " " + hostInfo.PlatformVersion)
		info.Virtualization = hostInfo.VirtualizationSystem
		info.Uptime = int64(hostInfo.Uptime)
	}
	if cpuInfo, err := cpu.Info(); err == nil && len(cpuInfo) > 0 {
		info.CPUName = cpuInfo[0].ModelName
		info.CPUCores = len(cpuInfo)
	}
	if memInfo, err := mem.VirtualMemory(); err == nil {
		info.MemTotal = int64(memInfo.Total)
	}
	if swapInfo, err := mem.SwapMemory(); err == nil {
		info.SwapTotal = int64(swapInfo.Total)
	}
	if partitions, err := disk.Partitions(false); err == nil {
		var totalDisk int64
		for _, p := range selectDiskPartitions(partitions, mountInclude, mountExclude) {
			if usage, err := disk.Usage(p.Mountpoint); err == nil {
				totalDisk += int64(usage.Total)
			}
		}
		info.DiskTotal = totalDisk
	}

	// GPU detection
	gpuName, gpuDetails := detectGPU()
	info.GPUName = gpuName

	// Store detailed GPU info globally for reports
	gpuDetailsMu.Lock()
	globalGPUDetails = gpuDetails
	gpuDetailsMu.Unlock()

	return info
}

func parseFilterList(value string) []string {
	parts := strings.Split(value, ",")
	filters := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			filters = append(filters, part)
		}
	}
	return filters
}

func matchFilter(value string, filters []string) bool {
	for _, filter := range filters {
		if filter == value {
			return true
		}
		if matched, err := filepath.Match(filter, value); err == nil && matched {
			return true
		}
	}
	return false
}

func partitionMatchesFilter(partition disk.PartitionStat, filters []string) bool {
	if len(filters) == 0 {
		return false
	}
	return matchFilter(partition.Mountpoint, filters) ||
		matchFilter(partition.Device, filters) ||
		matchFilter(partition.Fstype, filters)
}

func selectDiskPartitions(partitions []disk.PartitionStat, include string, exclude string) []disk.PartitionStat {
	includeFilters := parseFilterList(include)
	excludeFilters := parseFilterList(exclude)
	selected := make([]disk.PartitionStat, 0, len(partitions))
	for _, partition := range partitions {
		if len(includeFilters) > 0 && !partitionMatchesFilter(partition, includeFilters) {
			continue
		}
		if partitionMatchesFilter(partition, excludeFilters) {
			continue
		}
		selected = append(selected, partition)
	}
	return selected
}

func interfaceMatchesFilter(name string, filters []string) bool {
	if len(filters) == 0 {
		return false
	}
	return matchFilter(name, filters)
}

func sumNetworkCounters(counters []gnet.IOCountersStat, include string, exclude string) (int64, int64) {
	includeFilters := parseFilterList(include)
	excludeFilters := parseFilterList(exclude)
	var sent, received int64
	for _, counter := range counters {
		if len(includeFilters) > 0 && !interfaceMatchesFilter(counter.Name, includeFilters) {
			continue
		}
		if interfaceMatchesFilter(counter.Name, excludeFilters) {
			continue
		}
		sent += int64(counter.BytesSent)
		received += int64(counter.BytesRecv)
	}
	return sent, received
}

var (
	globalGPUDetails []GPUInfo
	gpuDetailsMu     sync.Mutex
)

func collectReportWithInterval(intervalSec int) Report {
	r := Report{Version: Version, ReportInterval: intervalSec, Timestamp: time.Now().UnixMilli()}
	r.IPv4, r.IPv6 = localIPAddresses()

	if percent, err := cpu.Percent(time.Second, false); err == nil && len(percent) > 0 {
		r.CPU = percent[0]
	}
	if memInfo, err := mem.VirtualMemory(); err == nil {
		r.RAM = int64(memInfo.Used)
		r.RAMTotal = int64(memInfo.Total)
	}
	if swapInfo, err := mem.SwapMemory(); err == nil {
		r.Swap = int64(swapInfo.Used)
		r.SwapTotal = int64(swapInfo.Total)
	}
	if loadInfo, err := load.Avg(); err == nil {
		r.Load = loadInfo.Load1
	}
	if partitions, err := disk.Partitions(false); err == nil {
		var usedDisk, totalDisk int64
		for _, p := range selectDiskPartitions(partitions, mountInclude, mountExclude) {
			if usage, err := disk.Usage(p.Mountpoint); err == nil {
				usedDisk += int64(usage.Used)
				totalDisk += int64(usage.Total)
			}
		}
		r.Disk = usedDisk
		r.DiskTotal = totalDisk
	}
	filterNetwork := strings.TrimSpace(nicInclude) != "" || strings.TrimSpace(nicExclude) != ""
	if netIO, err := gnet.IOCounters(filterNetwork); err == nil && len(netIO) > 0 {
		if filterNetwork {
			r.NetTotalUp, r.NetTotalDown = sumNetworkCounters(netIO, nicInclude, nicExclude)
		} else {
			r.NetTotalUp = int64(netIO[0].BytesSent)
			r.NetTotalDown = int64(netIO[0].BytesRecv)
		}
	}
	if processes, err := process.Processes(); err == nil {
		r.ProcessCount = len(processes)
	}
	if conns, err := gnet.Connections("tcp"); err == nil {
		r.Connections = len(conns)
	}
	if udpConns, err := gnet.Connections("udp"); err == nil {
		r.ConnectionsUdp = len(udpConns)
	}
	if hostInfo, err := host.Info(); err == nil {
		r.Uptime = int64(hostInfo.Uptime)
	}

	// GPU details
	gpuDetailsMu.Lock()
	if len(globalGPUDetails) > 0 {
		// Refresh GPU data for each report
		_, gpuDetails := detectGPU()
		r.GPUs = gpuDetails
		if len(gpuDetails) > 0 {
			// Average utilization across all GPUs
			var totalUtil float64
			for _, g := range gpuDetails {
				totalUtil += g.Utilization
			}
			r.GPU = totalUtil / float64(len(gpuDetails))
		}
	}
	gpuDetailsMu.Unlock()

	return r
}

func collectReport() Report {
	return collectReportWithInterval(reportInterval)
}

func (p *reportPreparer) prepare() Report {
	return p.prepareForInterval(time.Duration(reportInterval) * time.Second)
}

func (p *reportPreparer) prepareForInterval(interval time.Duration) Report {
	intervalSec := intervalSeconds(interval)
	report := collectReportWithInterval(intervalSec)
	return p.prepareReportForInterval(report, intervalSec)
}

func (p *reportPreparer) prepareReport(report Report) Report {
	intervalSec := report.ReportInterval
	if intervalSec < 1 {
		intervalSec = reportInterval
	}
	return p.prepareReportForInterval(report, intervalSec)
}

func (p *reportPreparer) prepareReportForInterval(report Report, intervalSec int) Report {
	if intervalSec < 1 {
		intervalSec = 1
	}
	report.ReportInterval = intervalSec
	if clientName != "" {
		report.Name = clientName
	}

	if !p.ready {
		p.lastNetUp = report.NetTotalUp
		p.lastNetDown = report.NetTotalDown
		p.lastTimestampMs = report.Timestamp
		p.ready = true
		return report
	}

	upDelta := report.NetTotalUp - p.lastNetUp
	downDelta := report.NetTotalDown - p.lastNetDown
	if upDelta < 0 {
		upDelta = 0
	}
	if downDelta < 0 {
		downDelta = 0
	}

	effectiveIntervalSec := intervalSec
	if report.Timestamp > 0 && p.lastTimestampMs > 0 {
		elapsedMs := report.Timestamp - p.lastTimestampMs
		if elapsedMs > 0 {
			effectiveIntervalSec = int((elapsedMs + 500) / 1000)
		}
	}
	minIntervalSec := int(minReportInterval / time.Second)
	if effectiveIntervalSec < minIntervalSec {
		effectiveIntervalSec = minIntervalSec
	}
	report.ReportInterval = effectiveIntervalSec
	report.NetOut = upDelta / int64(effectiveIntervalSec)
	report.NetIn = downDelta / int64(effectiveIntervalSec)
	p.lastNetUp = report.NetTotalUp
	p.lastNetDown = report.NetTotalDown
	p.lastTimestampMs = report.Timestamp

	return report
}

func sendHTTPReport(preparer *reportPreparer) {
	sendHTTPReportForInterval(preparer, time.Duration(reportInterval)*time.Second)
}

func sendHTTPReportForInterval(preparer *reportPreparer, interval time.Duration) {
	sendHTTPReports([]Report{preparer.prepareForInterval(interval)})
}

func sendHTTPReports(reports []Report) {
	if len(reports) == 0 {
		return
	}
	endpoint := serverURL + "/api/clients/report"
	payload := any(reports[0])
	if len(reports) > 1 {
		payload = map[string]any{"reports": reports}
	}
	if err := postJSON(endpoint, payload, token); err != nil {
		log.Printf("HTTP report failed: %v", err)
		return
	}
	if len(reports) == 1 {
		logReport("HTTP report sent", reports[0])
	} else {
		log.Printf("HTTP report batch sent: %d reports", len(reports))
	}
}

func fetchAgentPolicy() (agentPolicy, error) {
	endpoint := serverURL + "/api/clients/policy"
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return agentPolicy{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return agentPolicy{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return agentPolicy{}, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var policy agentPolicy
	if err := json.NewDecoder(resp.Body).Decode(&policy); err != nil {
		return agentPolicy{}, err
	}
	if policy.Type != "policy" {
		return agentPolicy{}, fmt.Errorf("unexpected policy type %q", policy.Type)
	}
	if policy.ReportIntervalSec < 1 {
		return agentPolicy{}, fmt.Errorf("invalid policy interval %d", policy.ReportIntervalSec)
	}
	if policy.SampleIntervalSec < 1 {
		policy.SampleIntervalSec = policy.ReportIntervalSec
	}
	return policy, nil
}

func sendWebSocketReport(conn *safeWebSocketConn, preparer *reportPreparer, interval time.Duration) error {
	return sendWebSocketReports(conn, []Report{preparer.prepareForInterval(interval)})
}

func sendWebSocketReports(conn *safeWebSocketConn, reports []Report) error {
	if len(reports) == 0 {
		return nil
	}
	if len(reports) == 1 {
		if err := conn.WriteJSON(reportEnvelope{Type: "report", Data: reports[0]}); err != nil {
			return err
		}
		logReport("WebSocket report sent", reports[0])
		return nil
	}
	if err := conn.WriteJSON(reportsEnvelope{Type: "reports", Reports: reports}); err != nil {
		return err
	}
	log.Printf("WebSocket report batch sent: %d reports", len(reports))
	return nil
}

func logReport(prefix string, report Report) {
	log.Printf("%s: CPU %.1f%%, RAM %.1fGB/%dGB, Net in=%dB/s out=%dB/s",
		prefix,
		report.CPU,
		float64(report.RAM)/1024/1024/1024,
		report.RAMTotal/1024/1024/1024,
		report.NetIn,
		report.NetOut,
	)
}

func postJSON(endpoint string, data interface{}, bearerToken string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return postJSONWithContext(ctx, endpoint, data, bearerToken)
}

func postJSONWithContext(ctx context.Context, endpoint string, data interface{}, bearerToken string) error {
	body, err := json.Marshal(data)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

func normalizeServerURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("empty server URL")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("missing host")
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func webSocketEndpoint(server string, _ string) (string, error) {
	parsed, err := url.Parse(server)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}

	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/api/clients/report"
	parsed.RawQuery = ""
	return parsed.String(), nil
}

func redactURLSecret(rawURL string, keys ...string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	query := parsed.Query()
	changed := false
	for _, key := range keys {
		if query.Has(key) {
			query.Set(key, "REDACTED")
			changed = true
		}
	}
	if !changed {
		return rawURL
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func connectWebSocket(endpoint string, agentToken string) (*safeWebSocketConn, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		Proxy:            http.ProxyFromEnvironment,
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+agentToken)
	conn, resp, err := dialer.Dial(endpoint, headers)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("%s", resp.Status)
		}
		return nil, err
	}
	return &safeWebSocketConn{conn: conn}, nil
}

func readWebSocketMessages(conn *safeWebSocketConn, done chan<- error, policies chan<- serverMessage) {
	// AGT-2: Panic recovery to prevent silent goroutine death
	defer func() {
		if r := recover(); r != nil {
			log.Printf("PANIC in readWebSocketMessages: %v", r)
			done <- fmt.Errorf("panic: %v", r)
		}
	}()

	// AGT-1: Set pong handler to refresh read deadline on server pong response
	conn.conn.SetPongHandler(func(appData string) error {
		// Refresh read deadline on each pong (server responds to our ping)
		return conn.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})

	// Set initial read deadline
	if err := conn.conn.SetReadDeadline(time.Now().Add(90 * time.Second)); err != nil {
		done <- err
		return
	}

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			done <- err
			return
		}

		// Refresh read deadline on every successful read
		if err := conn.conn.SetReadDeadline(time.Now().Add(90 * time.Second)); err != nil {
			done <- err
			return
		}

		var message serverMessage
		if err := json.Unmarshal(raw, &message); err != nil {
			log.Printf("WebSocket message: %s", string(raw))
			continue
		}
		if message.Type == "ack" {
			log.Printf("WebSocket ack received: %d", message.Timestamp)
			continue
		}
		if message.Type == "policy" {
			select {
			case policies <- message:
			default:
				log.Printf("WebSocket policy dropped: queue full")
			}
			continue
		}
		log.Printf("WebSocket message type=%s", message.Type)
	}
}

func (c *safeWebSocketConn) WriteMessage(messageType int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(messageType, data)
}

func (c *safeWebSocketConn) WriteJSON(data interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteJSON(data)
}

func (c *safeWebSocketConn) ReadMessage() (int, []byte, error) {
	return c.conn.ReadMessage()
}

func (c *safeWebSocketConn) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.Close()
}
