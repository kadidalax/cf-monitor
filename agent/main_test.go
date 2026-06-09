package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v3/disk"
	gnet "github.com/shirou/gopsutil/v3/net"
)

func TestNormalizeServerURL(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    string
		wantErr bool
	}{
		{
			name: "adds https scheme",
			raw:  "monitor.example.com",
			want: "https://monitor.example.com",
		},
		{
			name: "trims trailing slash path and removes query",
			raw:  " http://monitor.example.com/base/?token=secret#frag ",
			want: "http://monitor.example.com/base",
		},
		{
			name:    "rejects unsupported scheme",
			raw:     "ftp://monitor.example.com",
			wantErr: true,
		},
		{
			name:    "rejects empty value",
			raw:     " ",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeServerURL(tt.raw)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("normalizeServerURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestWebSocketEndpoint(t *testing.T) {
	tests := []struct {
		name    string
		server  string
		want    string
		wantErr bool
	}{
		{
			name:   "http becomes ws",
			server: "http://monitor.example.com",
			want:   "ws://monitor.example.com/api/clients/report",
		},
		{
			name:   "https path becomes wss report path",
			server: "https://monitor.example.com/base",
			want:   "wss://monitor.example.com/base/api/clients/report",
		},
		{
			name:    "unsupported scheme",
			server:  "ftp://monitor.example.com",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := webSocketEndpoint(tt.server, "secret")
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("webSocketEndpoint() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestProtocolJSONFieldNames(t *testing.T) {
	basicInfoBytes, err := json.Marshal(BasicInfo{
		CPUName:        "AMD EPYC",
		Virtualization: "kvm",
		Arch:           "amd64",
		CPUCores:       8,
		OS:             "linux",
		KernelVersion:  "6.8.0",
		GPUName:        "NVIDIA RTX",
		IPv4:           "192.0.2.10",
		IPv6:           "2001:db8::10",
		Region:         "ap-test",
		Version:        Version,
		Name:           "node-a",
		MemTotal:       1024,
		SwapTotal:      128,
		DiskTotal:      2048,
		Uptime:         60,
	})
	if err != nil {
		t.Fatalf("marshal basic info: %v", err)
	}
	var basicInfo map[string]json.RawMessage
	if err := json.Unmarshal(basicInfoBytes, &basicInfo); err != nil {
		t.Fatalf("decode basic info: %v", err)
	}
	for _, key := range []string{
		"cpu_name",
		"virtualization",
		"arch",
		"cpu_cores",
		"os",
		"kernel_version",
		"gpu_name",
		"ipv4",
		"ipv6",
		"region",
		"version",
		"name",
		"mem_total",
		"swap_total",
		"disk_total",
		"uptime",
	} {
		if _, ok := basicInfo[key]; !ok {
			t.Fatalf("basic info JSON missing key %q in %s", key, string(basicInfoBytes))
		}
	}

	reportBytes, err := json.Marshal(Report{
		Token:          "agent-token",
		CPU:            12.5,
		GPU:            30,
		RAM:            1024,
		RAMTotal:       2048,
		Swap:           128,
		SwapTotal:      256,
		Load:           0.75,
		Temp:           45,
		Disk:           4096,
		DiskTotal:      8192,
		NetIn:          10,
		NetOut:         20,
		NetTotalUp:     100,
		NetTotalDown:   200,
		ProcessCount:   3,
		Connections:    4,
		ConnectionsUdp: 5,
		Uptime:         60,
		Version:        Version,
		Name:           "node-a",
		ReportInterval: 5,
		IPv4:           "192.0.2.10",
		IPv6:           "2001:db8::10",
		GPUs: []GPUInfo{{
			DeviceIndex: 0,
			DeviceName:  "NVIDIA RTX",
			MemTotal:    16,
			MemUsed:     8,
			Utilization: 50,
			Temperature: 70,
		}},
	})
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}

	var report map[string]json.RawMessage
	if err := json.Unmarshal(reportBytes, &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	for _, key := range []string{
		"token",
		"cpu",
		"gpu",
		"ram",
		"ram_total",
		"swap",
		"swap_total",
		"load",
		"temp",
		"disk",
		"disk_total",
		"net_in",
		"net_out",
		"net_total_up",
		"net_total_down",
		"process_count",
		"connections",
		"connections_udp",
		"uptime",
		"version",
		"name",
		"report_interval",
		"ipv4",
		"ipv6",
		"gpus",
	} {
		if _, ok := report[key]; !ok {
			t.Fatalf("report JSON missing key %q in %s", key, string(reportBytes))
		}
	}

	var gpuPayload []map[string]json.RawMessage
	if err := json.Unmarshal(report["gpus"], &gpuPayload); err != nil {
		t.Fatalf("decode GPUs: %v", err)
	}
	for _, key := range []string{"device_index", "device_name", "mem_total", "mem_used", "utilization", "temperature"} {
		if _, ok := gpuPayload[0][key]; !ok {
			t.Fatalf("GPU JSON missing key %q in %s", key, string(report["gpus"]))
		}
	}

	taskBytes := []byte(`{"id":42,"name":"tcp-check","type":"tcp","target":"127.0.0.1:80","interval_sec":30,"clients":["node-a"],"all_clients":false}`)
	var task PingTask
	if err := json.Unmarshal(taskBytes, &task); err != nil {
		t.Fatalf("decode ping task: %v", err)
	}
	if task.ID != 42 || task.Name != "tcp-check" || task.Type != "tcp" || task.Target != "127.0.0.1:80" || task.IntervalSec != 30 || len(task.Clients) != 1 || task.Clients[0] != "node-a" || task.AllClients {
		t.Fatalf("decoded ping task = %#v, want Worker protocol fields mapped", task)
	}

	pingBytes, err := json.Marshal(PingResult{TaskID: 42, Value: 12.3})
	if err != nil {
		t.Fatalf("marshal ping result: %v", err)
	}
	var ping map[string]json.RawMessage
	if err := json.Unmarshal(pingBytes, &ping); err != nil {
		t.Fatalf("decode ping result: %v", err)
	}
	for _, key := range []string{"task_id", "value"} {
		if _, ok := ping[key]; !ok {
			t.Fatalf("ping result JSON missing key %q in %s", key, string(pingBytes))
		}
	}
}

func TestVersionCanBeOverriddenForReleaseBuild(t *testing.T) {
	original := Version
	Version = "9.9.9-test"
	t.Cleanup(func() { Version = original })

	info := getBasicInfo()
	if info.Version != "9.9.9-test" {
		t.Fatalf("getBasicInfo version = %q, want build override", info.Version)
	}
}

func TestApplyEnvDefaults(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	previousClientName := clientName
	previousReportMode := reportMode
	previousMountInclude := mountInclude
	previousMountExclude := mountExclude
	previousNicInclude := nicInclude
	previousNicExclude := nicExclude
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
		clientName = previousClientName
		reportMode = previousReportMode
		mountInclude = previousMountInclude
		mountExclude = previousMountExclude
		nicInclude = previousNicInclude
		nicExclude = previousNicExclude
	})

	t.Setenv("CF_MONITOR_TOKEN", "env-token")
	t.Setenv("CF_MONITOR_SERVER", "https://env.example.com")
	t.Setenv("CF_MONITOR_NAME", "env-node")
	t.Setenv("CF_MONITOR_MODE", "http")
	t.Setenv("CF_MONITOR_MOUNT_INCLUDE", "/,/data")
	t.Setenv("CF_MONITOR_MOUNT_EXCLUDE", "/boot")
	t.Setenv("CF_MONITOR_NIC_INCLUDE", "eth*,ens*")
	t.Setenv("CF_MONITOR_NIC_EXCLUDE", "docker*,lo")

	token = ""
	serverURL = ""
	clientName = ""
	reportMode = "websocket"
	mountInclude = ""
	mountExclude = ""
	nicInclude = ""
	nicExclude = ""

	applyEnvDefaults()

	if token != "env-token" || serverURL != "https://env.example.com" || clientName != "env-node" || reportMode != "http" ||
		mountInclude != "/,/data" || mountExclude != "/boot" || nicInclude != "eth*,ens*" || nicExclude != "docker*,lo" {
		t.Fatalf("env defaults token/server/name/mode/filters = %q/%q/%q/%q/%q/%q/%q/%q",
			token, serverURL, clientName, reportMode, mountInclude, mountExclude, nicInclude, nicExclude)
	}

	t.Setenv("CF_MONITOR_TOKEN", "ignored-token")
	t.Setenv("CF_MONITOR_SERVER", "")
	t.Setenv("CF_MONITOR_NAME", "ignored-node")
	t.Setenv("CF_MONITOR_MODE", "ignored-mode")
	t.Setenv("CF_MONITOR_MOUNT_INCLUDE", "ignored-mount")
	t.Setenv("CF_MONITOR_MOUNT_EXCLUDE", "ignored-exclude")
	t.Setenv("CF_MONITOR_NIC_INCLUDE", "ignored-nic")
	t.Setenv("CF_MONITOR_NIC_EXCLUDE", "ignored-nic-exclude")

	token = "explicit-token"
	serverURL = ""
	clientName = "explicit-node"
	reportMode = "http"
	mountInclude = "/explicit"
	mountExclude = "/explicit-exclude"
	nicInclude = "explicit-nic"
	nicExclude = "explicit-nic-exclude"

	applyEnvDefaults()

	if token != "explicit-token" {
		t.Fatalf("token = %q, want explicit value preserved", token)
	}
	if serverURL != "" {
		t.Fatalf("serverURL = %q, want empty value preserved until validation", serverURL)
	}
	if clientName != "explicit-node" {
		t.Fatalf("clientName = %q, want explicit value preserved", clientName)
	}
	if reportMode != "http" {
		t.Fatalf("reportMode = %q, want non-default explicit mode preserved", reportMode)
	}
	if mountInclude != "/explicit" || mountExclude != "/explicit-exclude" || nicInclude != "explicit-nic" || nicExclude != "explicit-nic-exclude" {
		t.Fatalf("explicit filters were overwritten: %q/%q/%q/%q", mountInclude, mountExclude, nicInclude, nicExclude)
	}
}

func TestSelectDiskPartitionsPreservesOldBehaviorWithoutFilters(t *testing.T) {
	partitions := []disk.PartitionStat{
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
		{Device: "/dev/sdb1", Mountpoint: "/data", Fstype: "xfs"},
	}

	got := selectDiskPartitions(partitions, "", "")
	if len(got) != len(partitions) {
		t.Fatalf("selected partitions = %#v, want all partitions without filters", got)
	}
}

func TestSelectDiskPartitionsIncludeAndExclude(t *testing.T) {
	partitions := []disk.PartitionStat{
		{Device: "/dev/sda1", Mountpoint: "/", Fstype: "ext4"},
		{Device: "/dev/sdb1", Mountpoint: "/data", Fstype: "xfs"},
		{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
		{Device: "/dev/sdc1", Mountpoint: "/backup", Fstype: "ext4"},
	}

	got := selectDiskPartitions(partitions, "/,/data,/backup", "tmpfs,/backup")
	if len(got) != 2 {
		t.Fatalf("selected partitions = %#v, want root and data only", got)
	}
	if got[0].Mountpoint != "/" || got[1].Mountpoint != "/data" {
		t.Fatalf("selected mountpoints = %#v, want / and /data", got)
	}
}

func TestSumNetworkCountersUsesInterfaceFilters(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "lo", BytesSent: 10, BytesRecv: 20},
		{Name: "eth0", BytesSent: 100, BytesRecv: 200},
		{Name: "ens3", BytesSent: 300, BytesRecv: 400},
		{Name: "docker0", BytesSent: 1000, BytesRecv: 2000},
	}

	up, down := sumNetworkCounters(counters, "eth*,ens*", "docker*,lo")
	if up != 400 || down != 600 {
		t.Fatalf("filtered network totals = %d/%d, want 400/600", up, down)
	}
}

func TestSumNetworkCountersKeepsAllCountersWithoutFilters(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 100, BytesRecv: 200},
		{Name: "docker0", BytesSent: 300, BytesRecv: 400},
	}

	up, down := sumNetworkCounters(counters, "", "")
	if up != 400 || down != 600 {
		t.Fatalf("unfiltered network totals = %d/%d, want all counters summed", up, down)
	}
}

func TestPingTaskSchedulerDueTasks(t *testing.T) {
	previousPingInterval := pingInterval
	pingInterval = 30
	t.Cleanup(func() { pingInterval = previousPingInterval })

	scheduler := newPingTaskScheduler()
	now := time.Date(2026, 6, 7, 12, 0, 0, 0, time.UTC)
	tasks := []PingTask{
		{ID: 1, Name: "fast", IntervalSec: 10},
		{ID: 2, Name: "fallback interval", IntervalSec: 0},
		{ID: 0, Name: "invalid"},
	}

	first := scheduler.dueTasks(tasks, now)
	if len(first) != 2 {
		t.Fatalf("first due count = %d, want 2", len(first))
	}

	second := scheduler.dueTasks(tasks, now.Add(9*time.Second))
	if len(second) != 0 {
		t.Fatalf("second due count = %d, want 0", len(second))
	}

	third := scheduler.dueTasks(tasks, now.Add(10*time.Second))
	if len(third) != 1 || third[0].ID != 1 {
		t.Fatalf("third due tasks = %#v, want only task 1", third)
	}

	fourth := scheduler.dueTasks([]PingTask{{ID: 1, IntervalSec: 10}}, now.Add(20*time.Second))
	if len(fourth) != 1 || fourth[0].ID != 1 {
		t.Fatalf("fourth due tasks = %#v, want task 1", fourth)
	}
	if _, ok := scheduler.lastRunByTaskID[2]; ok {
		t.Fatalf("scheduler should forget tasks no longer returned by server")
	}
}

func TestPingTaskIntervalFallbacks(t *testing.T) {
	previousPingInterval := pingInterval
	t.Cleanup(func() { pingInterval = previousPingInterval })

	pingInterval = 45
	if got := pingTaskInterval(PingTask{IntervalSec: 0}); got != 45*time.Second {
		t.Fatalf("pingTaskInterval(global fallback) = %s, want 45s", got)
	}

	pingInterval = 0
	if got := pingTaskInterval(PingTask{IntervalSec: 0}); got != 60*time.Second {
		t.Fatalf("pingTaskInterval(default fallback) = %s, want 60s", got)
	}
}

func TestPingPollDelayFollowsShortestReturnedTaskInterval(t *testing.T) {
	if got := pingPollDelay(nil, 0, 0); got != 60*time.Second {
		t.Fatalf("pingPollDelay(empty fallback) = %s, want 60s", got)
	}

	if got := pingPollDelay([]PingTask{
		{ID: 1, IntervalSec: 60},
		{ID: 2, IntervalSec: 120},
	}, 60, 0); got != 60*time.Second {
		t.Fatalf("pingPollDelay(default tasks) = %s, want 60s", got)
	}

	if got := pingPollDelay([]PingTask{
		{ID: 1, IntervalSec: 60},
		{ID: 2, IntervalSec: 10},
	}, 60, 0); got != 10*time.Second {
		t.Fatalf("pingPollDelay(short task) = %s, want 10s", got)
	}

	if got := pingPollDelay([]PingTask{
		{ID: 1, IntervalSec: 120},
	}, 45, 0); got != 45*time.Second {
		t.Fatalf("pingPollDelay(configured cap) = %s, want 45s", got)
	}

	if got := pingPollDelay(nil, 60, 600); got != 600*time.Second {
		t.Fatalf("pingPollDelay(server suggestion) = %s, want 600s", got)
	}

	if got := pingPollDelay([]PingTask{
		{ID: 1, IntervalSec: 10},
	}, 60, 600); got != 10*time.Second {
		t.Fatalf("pingPollDelay(task shorter than suggestion) = %s, want 10s", got)
	}
}

func TestDecodePingTasksResponseSupportsLegacyAndV2(t *testing.T) {
	legacyTasks, legacyNextPoll, err := decodePingTasksResponse(strings.NewReader(`[{"id":1,"name":"legacy","interval_sec":60}]`))
	if err != nil {
		t.Fatalf("decode legacy ping tasks: %v", err)
	}
	if len(legacyTasks) != 1 || legacyTasks[0].ID != 1 || legacyNextPoll != 0 {
		t.Fatalf("legacy ping tasks = %#v next=%d, want one task and no suggestion", legacyTasks, legacyNextPoll)
	}

	v2Tasks, v2NextPoll, err := decodePingTasksResponse(strings.NewReader(`{"tasks":[{"id":2,"name":"v2","interval_sec":120}],"next_poll_sec":600}`))
	if err != nil {
		t.Fatalf("decode v2 ping tasks: %v", err)
	}
	if len(v2Tasks) != 1 || v2Tasks[0].ID != 2 || v2NextPoll != 600 {
		t.Fatalf("v2 ping tasks = %#v next=%d, want one task and 600s suggestion", v2Tasks, v2NextPoll)
	}
}

func TestExecuteHTTPPing(t *testing.T) {
	okServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer okServer.Close()

	if got := executeHTTPPing(okServer.URL); got < 0 {
		t.Fatalf("executeHTTPPing(ok) = %v, want non-negative latency", got)
	}

	failServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer failServer.Close()

	if got := executeHTTPPing(failServer.URL); got != -1 {
		t.Fatalf("executeHTTPPing(500) = %v, want -1", got)
	}

	if got := executeHTTPPing("http://127.0.0.1:1"); got != -1 {
		t.Fatalf("executeHTTPPing(closed port) = %v, want -1", got)
	}
}

func TestExecuteTCPPing(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err == nil {
			_ = conn.Close()
		}
	}()

	if got := executeTCPPing(listener.Addr().String()); got < 0 {
		t.Fatalf("executeTCPPing(open port) = %v, want non-negative latency", got)
	}
	<-done

	closedListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen closed port: %v", err)
	}
	closedAddress := closedListener.Addr().String()
	closedListener.Close()

	if got := executeTCPPing(closedAddress); got != -1 {
		t.Fatalf("executeTCPPing(closed port) = %v, want -1", got)
	}
}

func TestParseNvidiaGPUOutput(t *testing.T) {
	output := `
0, NVIDIA RTX 4090, 24564, 1024, 87, 66
bad row
1, NVIDIA T4, 15360, 512, 12.5, 44
`
	names, details := parseNvidiaGPUOutput(output)

	if strings.Join(names, ";") != "NVIDIA RTX 4090;NVIDIA T4" {
		t.Fatalf("names = %#v, want parsed NVIDIA GPU names", names)
	}
	if len(details) != 2 {
		t.Fatalf("details len = %d, want 2", len(details))
	}
	if details[0].DeviceIndex != 0 || details[0].DeviceName != "NVIDIA RTX 4090" {
		t.Fatalf("first GPU identity = %#v", details[0])
	}
	if details[0].MemTotal != 24564*1024*1024 || details[0].MemUsed != 1024*1024*1024 {
		t.Fatalf("first GPU memory = %d/%d, want MiB converted to bytes", details[0].MemUsed, details[0].MemTotal)
	}
	if details[0].Utilization != 87 || details[0].Temperature != 66 {
		t.Fatalf("first GPU util/temp = %.1f/%d, want 87/66", details[0].Utilization, details[0].Temperature)
	}
	if details[1].Utilization != 12.5 {
		t.Fatalf("second GPU utilization = %.1f, want 12.5", details[1].Utilization)
	}
}

func TestParseNvidiaGPUOutputSkipsMalformedNumbers(t *testing.T) {
	output := `
0, Good GPU, 100, 25, 50, 40
1, Bad GPU, unknown, 25, 50, 40
2, Also Good, 200, 50, 75, 55
`
	names, details := parseNvidiaGPUOutput(output)

	if len(names) != 2 || len(details) != 2 {
		t.Fatalf("parsed names/details = %#v/%#v, want malformed row skipped", names, details)
	}
	if details[1].DeviceIndex != 2 || details[1].DeviceName != "Also Good" {
		t.Fatalf("second parsed GPU = %#v, want device 2", details[1])
	}
}

func TestParseAMDGPUOutput(t *testing.T) {
	names, details := parseAMDGPUOutput(`
========================ROCm System Management Interface========================
GPU[1]          : Card series:      AMD Radeon RX 7800 XT
GPU[1]          : GPU use (%):      12.5
GPU[1]          : VRAM Total Used Memory (B):  1073741824
GPU[1]          : VRAM Total Memory (B):       17179869184
GPU[1]          : Temperature (Sensor junction) (C): 55.0
GPU[0]          : Card series:      AMD Radeon RX 7900 XTX
GPU[0]          : GPU use (%):      87
GPU[0]          : VRAM Total Used Memory (B):  2147483648
GPU[0]          : VRAM Total Memory (B):       25769803776
GPU[0]          : Temperature (Sensor edge) (C): 62
`)

	if len(names) != 2 || names[0] != "AMD Radeon RX 7900 XTX" || names[1] != "AMD Radeon RX 7800 XT" {
		t.Fatalf("names = %#v, want ROCm GPU names sorted by index", names)
	}
	if len(details) != 2 || details[0].DeviceIndex != 0 || details[0].DeviceName != names[0] {
		t.Fatalf("details = %#v, want matching AMD GPU details", details)
	}
	if details[0].Utilization != 87 || details[0].MemUsed != 2147483648 || details[0].MemTotal != 25769803776 || details[0].Temperature != 62 {
		t.Fatalf("first AMD detail = %#v, want utilization/memory/temp parsed", details[0])
	}
	if details[1].Utilization != 12.5 || details[1].MemUsed != 1073741824 || details[1].MemTotal != 17179869184 || details[1].Temperature != 55 {
		t.Fatalf("second AMD detail = %#v, want utilization/memory/temp parsed", details[1])
	}

	names, details = parseAMDGPUOutput("")
	if len(names) != 1 || names[0] != "AMD GPU" || len(details) != 1 || details[0].DeviceName != "AMD GPU" {
		t.Fatalf("empty output parse = %#v/%#v, want generic AMD GPU fallback", names, details)
	}
}

func TestReportPreparerComputesNetworkRateAndHandlesCounterReset(t *testing.T) {
	previousToken := token
	previousClientName := clientName
	previousReportInterval := reportInterval
	token = "agent-token"
	clientName = "test-node"
	reportInterval = 5
	t.Cleanup(func() {
		token = previousToken
		clientName = previousClientName
		reportInterval = previousReportInterval
	})

	preparer := &reportPreparer{}
	first := preparer.prepareReport(Report{NetTotalUp: 1_000, NetTotalDown: 2_000})
	if first.Token != token || first.Name != clientName {
		t.Fatalf("first report token/name = %q/%q, want globals copied", first.Token, first.Name)
	}
	if first.NetOut != 0 || first.NetIn != 0 {
		t.Fatalf("first report rates = in %d out %d, want initial sample to be zero", first.NetIn, first.NetOut)
	}

	second := preparer.prepareReport(Report{NetTotalUp: 1_750, NetTotalDown: 3_250})
	if second.NetOut != 150 || second.NetIn != 250 {
		t.Fatalf("second report rates = in %d out %d, want 250/150 Bps", second.NetIn, second.NetOut)
	}

	reset := preparer.prepareReport(Report{NetTotalUp: 100, NetTotalDown: 100})
	if reset.NetOut != 0 || reset.NetIn != 0 {
		t.Fatalf("counter reset rates = in %d out %d, want clamped zero", reset.NetIn, reset.NetOut)
	}
}

func TestReportPreparerUsesDynamicIntervalForNetworkRate(t *testing.T) {
	previousToken := token
	previousClientName := clientName
	token = "agent-token"
	clientName = "dynamic-node"
	t.Cleanup(func() {
		token = previousToken
		clientName = previousClientName
	})

	preparer := &reportPreparer{}
	_ = preparer.prepareReportForInterval(Report{NetTotalUp: 1_000, NetTotalDown: 2_000}, 600)
	next := preparer.prepareReportForInterval(Report{NetTotalUp: 1_900, NetTotalDown: 3_200}, 3)
	if next.ReportInterval != 3 {
		t.Fatalf("report interval = %d, want dynamic interval 3", next.ReportInterval)
	}
	if next.NetOut != 300 || next.NetIn != 400 {
		t.Fatalf("dynamic rates = in %d out %d, want 400/300 Bps", next.NetIn, next.NetOut)
	}
}

func TestReportPreparerUsesActualElapsedTimeWhenAvailable(t *testing.T) {
	previousToken := token
	token = "agent-token"
	t.Cleanup(func() { token = previousToken })

	preparer := &reportPreparer{}
	_ = preparer.prepareReportForInterval(Report{
		NetTotalUp:   1_000,
		NetTotalDown: 2_000,
		Timestamp:    1_000,
	}, 3)
	next := preparer.prepareReportForInterval(Report{
		NetTotalUp:   1_900,
		NetTotalDown: 3_200,
		Timestamp:    4_000,
	}, 600)

	if next.ReportInterval != 3 {
		t.Fatalf("report interval = %d, want actual elapsed 3s", next.ReportInterval)
	}
	if next.NetOut != 300 || next.NetIn != 400 {
		t.Fatalf("actual elapsed rates = in %d out %d, want 400/300 Bps", next.NetIn, next.NetOut)
	}
}

func TestPostJSONSendsBearerTokenAndBody(t *testing.T) {
	const wantToken = "agent-token"
	var gotAuth string
	var gotPayload map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", r.Header.Get("Content-Type"))
		}
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	if err := postJSON(server.URL, map[string]string{"hello": "world"}, wantToken); err != nil {
		t.Fatalf("postJSON returned error: %v", err)
	}
	if gotAuth != "Bearer "+wantToken {
		t.Fatalf("Authorization = %q, want Bearer token", gotAuth)
	}
	if gotPayload["hello"] != "world" {
		t.Fatalf("payload = %#v, want hello=world", gotPayload)
	}
}

func TestFetchAgentPolicyUsesBearerToken(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	token = "agent-token"
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
	})

	var gotAuth string
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/clients/policy" {
			http.NotFound(w, r)
			return
		}
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(agentPolicy{
			Type:              "policy",
			Mode:              "idle",
			ReportIntervalSec: 300,
			ReportNow:         false,
			ViewerCount:       0,
			ViewerTTLSec:      600,
			Timestamp:         time.Now().UnixMilli(),
		})
	}))
	defer worker.Close()

	serverURL = worker.URL
	policy, err := fetchAgentPolicy()
	if err != nil {
		t.Fatalf("fetchAgentPolicy returned error: %v", err)
	}
	if gotAuth != "Bearer "+token {
		t.Fatalf("Authorization = %q, want bearer token", gotAuth)
	}
	if policy.Type != "policy" || policy.Mode != "idle" || policy.ReportIntervalSec != 300 {
		t.Fatalf("policy = %#v, want idle policy interval 300", policy)
	}
}

func TestFetchAgentPolicyRejectsInvalidPayload(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	token = "agent-token"
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
	})

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"notice","report_interval_sec":0}`))
	}))
	defer worker.Close()

	serverURL = worker.URL
	if _, err := fetchAgentPolicy(); err == nil {
		t.Fatal("fetchAgentPolicy returned nil, want invalid policy error")
	}
}

func TestPolicyDurationsUseSampleAndUploadIntervals(t *testing.T) {
	sample, upload := policyDurations(agentPolicy{
		Type:              "policy",
		SampleIntervalSec: 3,
		ReportIntervalSec: 600,
	}, 5*time.Second)

	if sample != 3*time.Second || upload != 600*time.Second {
		t.Fatalf("policyDurations sample/upload = %s/%s, want 3s/10m", sample, upload)
	}

	sample, upload = policyDurations(agentPolicy{
		Type:              "policy",
		ReportIntervalSec: 7,
	}, 5*time.Second)

	if sample != 7*time.Second || upload != 7*time.Second {
		t.Fatalf("fallback policyDurations sample/upload = %s/%s, want 7s/7s", sample, upload)
	}
}

func TestReportDurationsClampToThreeSeconds(t *testing.T) {
	if got := normalizeReportDuration(500 * time.Millisecond); got != 3*time.Second {
		t.Fatalf("normalizeReportDuration(500ms) = %s, want 3s", got)
	}
	if got := normalizeReportDuration(time.Second); got != 3*time.Second {
		t.Fatalf("normalizeReportDuration(1s) = %s, want 3s", got)
	}
	if got := intervalSeconds(time.Second); got != 3 {
		t.Fatalf("intervalSeconds(1s) = %d, want 3", got)
	}

	sample, upload := policyDurations(agentPolicy{
		Type:              "policy",
		SampleIntervalSec: 1,
		ReportIntervalSec: 2,
	}, time.Second)
	if sample != 3*time.Second || upload != 3*time.Second {
		t.Fatalf("policyDurations low policy = %s/%s, want 3s/3s", sample, upload)
	}
}

func TestBasicInfoRefresherUploadsPeriodically(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	previousClientName := clientName
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	clientName = "refresh-node"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
		clientName = previousClientName
		log.SetOutput(previousLoggerOutput)
	})

	seen := make(chan BasicInfo, 3)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/clients/uploadBasicInfo" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		var info BasicInfo
		if err := json.NewDecoder(r.Body).Decode(&info); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		select {
		case seen <- info:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer worker.Close()

	serverURL = worker.URL
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		runBasicInfoRefresher(10*time.Millisecond, stop)
		close(done)
	}()

	defer func() {
		close(stop)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("basic info refresher did not stop")
		}
	}()

	for i := 0; i < 2; i++ {
		select {
		case info := <-seen:
			if info.Version != Version || info.Name != clientName {
				t.Fatalf("refreshed basic info = %#v, want version/name populated", info)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for periodic basic info upload %d", i+1)
		}
	}
}

func TestRESTEndpointsPreserveWorkerBasePath(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	previousReportInterval := reportInterval
	previousClientName := clientName
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	reportInterval = 1
	clientName = "base-node"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
		reportInterval = previousReportInterval
		clientName = previousClientName
		log.SetOutput(previousLoggerOutput)
	})

	pingTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer pingTarget.Close()

	seen := make(chan string, 4)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		seen <- r.URL.Path

		switch r.URL.Path {
		case "/base/api/clients/uploadBasicInfo":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case "/base/api/clients/report":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		case "/base/api/clients/ping/tasks":
			if r.Method != http.MethodGet {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]PingTask{{ID: 9, Name: "base-http", Type: "http", Target: pingTarget.URL, IntervalSec: 1, AllClients: true}})
		case "/base/api/clients/ping/result":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer worker.Close()

	normalized, err := normalizeServerURL(worker.URL + "/base/")
	if err != nil {
		t.Fatalf("normalize base worker URL: %v", err)
	}
	serverURL = normalized

	uploadBasicInfo()
	sendHTTPReport(&reportPreparer{})
	_, _ = executePingTasks(newPingTaskScheduler(), time.Now())

	want := map[string]bool{
		"/base/api/clients/uploadBasicInfo": false,
		"/base/api/clients/report":          false,
		"/base/api/clients/ping/tasks":      false,
		"/base/api/clients/ping/result":     false,
	}
	for i := 0; i < len(want); i++ {
		select {
		case path := <-seen:
			if _, ok := want[path]; !ok {
				t.Fatalf("unexpected request path %q", path)
			}
			want[path] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for request paths; seen %#v", want)
		}
	}
	for path, ok := range want {
		if !ok {
			t.Fatalf("missing request path %q; seen %#v", path, want)
		}
	}
}

func TestPostJSONReturnsHTTPErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "blocked", http.StatusTeapot)
	}))
	defer server.Close()

	err := postJSON(server.URL, map[string]string{"hello": "world"}, "agent-token")
	if err == nil {
		t.Fatal("postJSON returned nil, want HTTP error")
	}
	if !strings.Contains(err.Error(), "HTTP 418") || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("postJSON error = %q, want status and response body", err.Error())
	}
}

func TestExecutePingTasksSkipsInvalidTaskResponses(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
		log.SetOutput(previousLoggerOutput)
	})

	tests := []struct {
		name     string
		response func(http.ResponseWriter)
	}{
		{
			name: "server error",
			response: func(w http.ResponseWriter) {
				http.Error(w, "no tasks", http.StatusInternalServerError)
			},
		},
		{
			name: "invalid JSON",
			response: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{`))
			},
		},
		{
			name: "empty task list",
			response: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`[]`))
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var resultPosts int
			worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+token {
					http.Error(w, "missing bearer token", http.StatusUnauthorized)
					return
				}
				switch r.URL.Path {
				case "/api/clients/ping/tasks":
					tt.response(w)
				case "/api/clients/ping/result":
					resultPosts++
					w.WriteHeader(http.StatusNoContent)
				default:
					http.NotFound(w, r)
				}
			}))
			defer worker.Close()

			serverURL = worker.URL
			_, _ = executePingTasks(newPingTaskScheduler(), time.Now())

			if resultPosts != 0 {
				t.Fatalf("ping result posts = %d, want no report for invalid task response", resultPosts)
			}
		})
	}
}

func TestExecutePingTasksReportsLossValueForFailedTargets(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
		log.SetOutput(previousLoggerOutput)
	})

	closedListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen closed target: %v", err)
	}
	closedAddress := closedListener.Addr().String()
	closedListener.Close()

	resultCh := make(chan []PingResult, 1)
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/clients/ping/tasks":
			if r.Method != http.MethodGet {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			_ = json.NewEncoder(w).Encode([]PingTask{
				{ID: 8, Name: "closed-tcp", Type: "tcp", Target: closedAddress, IntervalSec: 1, AllClients: true},
			})
		case "/api/clients/ping/result":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			var results []PingResult
			if err := json.NewDecoder(r.Body).Decode(&results); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			resultCh <- results
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer worker.Close()

	serverURL = worker.URL
	_, _ = executePingTasks(newPingTaskScheduler(), time.Now())

	select {
	case results := <-resultCh:
		if len(results) != 1 || results[0].TaskID != 8 || results[0].Value != -1 {
			t.Fatalf("ping results = %#v, want task 8 with loss value -1", results)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for ping result report")
	}
}

func TestAgentProtocolAgainstMockWorker(t *testing.T) {
	previousToken := token
	previousServerURL := serverURL
	previousReportInterval := reportInterval
	previousClientName := clientName
	previousPingInterval := pingInterval
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	reportInterval = 1
	clientName = "test-node"
	pingInterval = 1
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		serverURL = previousServerURL
		reportInterval = previousReportInterval
		clientName = previousClientName
		pingInterval = previousPingInterval
		log.SetOutput(previousLoggerOutput)
	})

	pingTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer pingTarget.Close()

	type capturedRequest struct {
		Method string
		Path   string
		Auth   string
		Body   []byte
	}
	var (
		mu       sync.Mutex
		requests []capturedRequest
	)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, capturedRequest{
			Method: r.Method,
			Path:   r.URL.Path,
			Auth:   r.Header.Get("Authorization"),
			Body:   body,
		})
		mu.Unlock()

		if r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/clients/uploadBasicInfo":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			var info BasicInfo
			if err := json.Unmarshal(body, &info); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if info.Version != Version || info.Name != clientName {
				http.Error(w, "invalid basic info", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"success":true}`))
		case "/api/clients/report":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			var report Report
			if err := json.Unmarshal(body, &report); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if report.Token != token || report.Version != Version || report.Name != clientName {
				http.Error(w, "invalid report", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"success":true,"persisted":true}`))
		case "/api/clients/ping/tasks":
			if r.Method != http.MethodGet {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			_ = json.NewEncoder(w).Encode([]PingTask{
				{ID: 7, Name: "mock-http", Type: "http", Target: pingTarget.URL, IntervalSec: 1, AllClients: true},
			})
		case "/api/clients/ping/result":
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			var results []PingResult
			if err := json.Unmarshal(body, &results); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			if len(results) != 1 || results[0].TaskID != 7 || results[0].Value < 0 {
				http.Error(w, "invalid ping result", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"success":true,"accepted":1}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer worker.Close()

	normalized, err := normalizeServerURL(worker.URL)
	if err != nil {
		t.Fatalf("normalize mock worker URL: %v", err)
	}
	serverURL = normalized

	uploadBasicInfo()
	sendHTTPReport(&reportPreparer{})
	_, _ = executePingTasks(newPingTaskScheduler(), time.Now())

	requirePath := func(path string) capturedRequest {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		for _, request := range requests {
			if request.Path == path {
				return request
			}
		}
		paths := make([]string, 0, len(requests))
		for _, request := range requests {
			paths = append(paths, request.Path)
		}
		t.Fatalf("missing request path %s; got %s", path, strings.Join(paths, ", "))
		return capturedRequest{}
	}

	for _, path := range []string{
		"/api/clients/uploadBasicInfo",
		"/api/clients/report",
		"/api/clients/ping/tasks",
		"/api/clients/ping/result",
	} {
		request := requirePath(path)
		if request.Auth != "Bearer "+token {
			t.Fatalf("%s Authorization = %q, want bearer token", path, request.Auth)
		}
	}

	var basicInfo BasicInfo
	if err := json.Unmarshal(requirePath("/api/clients/uploadBasicInfo").Body, &basicInfo); err != nil {
		t.Fatalf("decode basic info: %v", err)
	}
	if basicInfo.Version != Version || basicInfo.Name != clientName {
		t.Fatalf("basic info = %#v, want version/name populated", basicInfo)
	}

	var report Report
	if err := json.Unmarshal(requirePath("/api/clients/report").Body, &report); err != nil {
		t.Fatalf("decode report: %v", err)
	}
	if report.Token != token || report.ReportInterval != 3 {
		t.Fatalf("report token/interval = %q/%d, want %q/%d", report.Token, report.ReportInterval, token, 3)
	}

	var results []PingResult
	if err := json.Unmarshal(requirePath("/api/clients/ping/result").Body, &results); err != nil {
		t.Fatalf("decode ping results: %v", err)
	}
	if len(results) != 1 || results[0].TaskID != 7 {
		t.Fatalf("ping results = %#v, want task 7", results)
	}
}

func TestWebSocketReportAgainstMockWorker(t *testing.T) {
	previousToken := token
	previousReportInterval := reportInterval
	previousClientName := clientName
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	reportInterval = 2
	clientName = "ws-node"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		reportInterval = previousReportInterval
		clientName = previousClientName
		log.SetOutput(previousLoggerOutput)
	})

	upgrader := websocket.Upgrader{}
	reportCh := make(chan reportEnvelope, 1)
	authCh := make(chan string, 1)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/clients/report" {
			http.NotFound(w, r)
			return
		}
		authCh <- r.Header.Get("Authorization")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		var envelope reportEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Errorf("read report envelope: %v", err)
			return
		}
		reportCh <- envelope
		_ = conn.WriteJSON(map[string]any{"type": "ack", "timestamp": time.Now().UnixMilli()})
	}))
	defer worker.Close()

	normalized, err := normalizeServerURL(worker.URL)
	if err != nil {
		t.Fatalf("normalize mock worker URL: %v", err)
	}
	endpoint, err := webSocketEndpoint(normalized, token)
	if err != nil {
		t.Fatalf("webSocketEndpoint: %v", err)
	}

	conn, err := connectWebSocket(endpoint, token)
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}
	defer conn.Close()

	if err := sendWebSocketReport(conn, &reportPreparer{}, time.Duration(reportInterval)*time.Second); err != nil {
		t.Fatalf("sendWebSocketReport: %v", err)
	}

	select {
	case gotAuth := <-authCh:
		if gotAuth != "Bearer "+token {
			t.Fatalf("WebSocket Authorization = %q, want bearer token", gotAuth)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for WebSocket auth")
	}

	select {
	case envelope := <-reportCh:
		if envelope.Type != "report" {
			t.Fatalf("envelope type = %q, want report", envelope.Type)
		}
		if envelope.Data.Token != token || envelope.Data.Name != clientName || envelope.Data.ReportInterval != 3 {
			t.Fatalf("envelope data token/name/interval = %q/%q/%d, want %q/%q/%d",
				envelope.Data.Token,
				envelope.Data.Name,
				envelope.Data.ReportInterval,
				token,
				clientName,
				3,
			)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for WebSocket report")
	}
}

func TestSendWebSocketReportsSendsBatchEnvelope(t *testing.T) {
	previousToken := token
	token = "agent-token"
	t.Cleanup(func() { token = previousToken })

	upgrader := websocket.Upgrader{}
	reportCh := make(chan reportsEnvelope, 1)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		var envelope reportsEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Errorf("read reports envelope: %v", err)
			return
		}
		reportCh <- envelope
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, token)
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}
	defer conn.Close()

	reports := []Report{
		{Token: token, CPU: 1, ReportInterval: 3, Timestamp: 1000},
		{Token: token, CPU: 2, ReportInterval: 3, Timestamp: 4000},
	}
	if err := sendWebSocketReports(conn, reports); err != nil {
		t.Fatalf("sendWebSocketReports: %v", err)
	}

	select {
	case envelope := <-reportCh:
		if envelope.Type != "reports" || len(envelope.Reports) != 2 {
			t.Fatalf("batch envelope = %#v, want two reports", envelope)
		}
		if envelope.Reports[0].Timestamp != 1000 || envelope.Reports[1].Timestamp != 4000 {
			t.Fatalf("batch timestamps = %d/%d, want preserved values", envelope.Reports[0].Timestamp, envelope.Reports[1].Timestamp)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for WebSocket report batch")
	}
}

func TestWebSocketSessionStopsWhenWorkerDisconnects(t *testing.T) {
	previousToken := token
	previousReportInterval := reportInterval
	previousClientName := clientName
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	reportInterval = 1
	clientName = "reconnect-node"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		reportInterval = previousReportInterval
		clientName = previousClientName
		log.SetOutput(previousLoggerOutput)
	})

	upgrader := websocket.Upgrader{}
	reportCh := make(chan reportEnvelope, 1)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		var envelope reportEnvelope
		if err := conn.ReadJSON(&envelope); err != nil {
			t.Errorf("read initial report: %v", err)
			return
		}
		reportCh <- envelope
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, token)
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- runWebSocketSession(conn, &reportPreparer{}, time.Hour, time.Hour)
	}()

	select {
	case envelope := <-reportCh:
		if envelope.Type != "report" || envelope.Data.Token != token || envelope.Data.Name != clientName {
			t.Fatalf("initial envelope = %#v, want report with token/name", envelope)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial WebSocket report")
	}

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("runWebSocketSession returned nil after worker disconnected")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("session did not stop after worker disconnected")
	}
}

func TestWebSocketSessionAppliesPolicyAndReportsImmediately(t *testing.T) {
	previousToken := token
	previousReportInterval := reportInterval
	previousClientName := clientName
	previousLoggerOutput := log.Writer()
	token = "agent-token"
	reportInterval = 600
	clientName = "policy-node"
	log.SetOutput(io.Discard)
	t.Cleanup(func() {
		token = previousToken
		reportInterval = previousReportInterval
		clientName = previousClientName
		log.SetOutput(previousLoggerOutput)
	})

	upgrader := websocket.Upgrader{}
	reportCh := make(chan reportEnvelope, 2)
	policySent := make(chan struct{}, 1)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		var initial reportEnvelope
		if err := conn.ReadJSON(&initial); err != nil {
			t.Errorf("read initial report: %v", err)
			return
		}
		reportCh <- initial
		if err := conn.WriteJSON(serverMessage{
			Type:              "policy",
			Mode:              "active",
			ReportIntervalSec: 3,
			ReportNow:         true,
			ViewerCount:       1,
			ViewerTTLSec:      600,
			Timestamp:         time.Now().UnixMilli(),
		}); err != nil {
			t.Errorf("write policy: %v", err)
			return
		}
		policySent <- struct{}{}

		var immediate reportEnvelope
		if err := conn.ReadJSON(&immediate); err != nil {
			t.Errorf("read immediate report: %v", err)
			return
		}
		reportCh <- immediate
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, token)
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- runWebSocketSession(conn, &reportPreparer{}, time.Hour, time.Hour)
	}()

	select {
	case initial := <-reportCh:
		if initial.Data.ReportInterval != 3600 {
			t.Fatalf("initial report interval = %d, want 3600", initial.Data.ReportInterval)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial report")
	}

	select {
	case <-policySent:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for policy send")
	}

	select {
	case immediate := <-reportCh:
		if immediate.Type != "report" || immediate.Data.ReportInterval != 3 {
			t.Fatalf("immediate envelope = %#v, want report interval 3", immediate)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for immediate policy report")
	}

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("runWebSocketSession returned nil after worker disconnected")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("session did not stop after worker disconnected")
	}
}

func TestConnectWebSocketReturnsHandshakeStatus(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "denied", http.StatusUnauthorized)
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, "bad-token")
	if err == nil {
		conn.Close()
		t.Fatal("connectWebSocket returned nil error, want handshake failure")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("connectWebSocket error = %q, want HTTP status", err.Error())
	}
}

func TestReadWebSocketMessagesHandlesMessagesUntilClose(t *testing.T) {
	previousLoggerOutput := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(previousLoggerOutput) })

	upgrader := websocket.Upgrader{}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		if err := conn.WriteMessage(websocket.TextMessage, []byte("not-json")); err != nil {
			t.Errorf("write raw message: %v", err)
			return
		}
		if err := conn.WriteJSON(map[string]any{"type": "ack", "timestamp": int64(123)}); err != nil {
			t.Errorf("write ack: %v", err)
			return
		}
		if err := conn.WriteJSON(map[string]any{"type": "notice"}); err != nil {
			t.Errorf("write notice: %v", err)
			return
		}
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, "agent-token")
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}
	defer conn.Close()

	done := make(chan error, 1)
	policies := make(chan serverMessage, 1)
	go readWebSocketMessages(conn, done, policies)

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("readWebSocketMessages returned nil error after close")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for readWebSocketMessages to stop")
	}
}

func TestSafeWebSocketConnWriteMessageAndReadMessage(t *testing.T) {
	upgrader := websocket.Upgrader{}
	messageCh := make(chan string, 1)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		messageType, data, err := conn.ReadMessage()
		if err != nil {
			t.Errorf("server ReadMessage: %v", err)
			return
		}
		if messageType != websocket.TextMessage {
			t.Errorf("message type = %d, want text", messageType)
			return
		}
		messageCh <- string(data)
		if err := conn.WriteMessage(websocket.TextMessage, []byte("ack")); err != nil {
			t.Errorf("server WriteMessage: %v", err)
		}
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, "agent-token")
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}

	select {
	case got := <-messageCh:
		if got != "hello" {
			t.Fatalf("server message = %q, want hello", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for server message")
	}

	messageType, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if messageType != websocket.TextMessage || string(data) != "ack" {
		t.Fatalf("client message = type %d body %q, want text ack", messageType, string(data))
	}
}

func TestSafeWebSocketConnAllowsConcurrentWrites(t *testing.T) {
	upgrader := websocket.Upgrader{}
	const writeCount = 20
	messageCh := make(chan map[string]int, writeCount)

	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()

		for i := 0; i < writeCount; i++ {
			var message map[string]int
			if err := conn.ReadJSON(&message); err != nil {
				t.Errorf("read JSON %d: %v", i, err)
				return
			}
			messageCh <- message
		}
	}))
	defer worker.Close()

	endpoint := "ws" + strings.TrimPrefix(worker.URL, "http")
	conn, err := connectWebSocket(endpoint, "agent-token")
	if err != nil {
		t.Fatalf("connectWebSocket: %v", err)
	}
	defer conn.Close()

	var wg sync.WaitGroup
	for i := 0; i < writeCount; i++ {
		wg.Add(1)
		go func(value int) {
			defer wg.Done()
			if err := conn.WriteJSON(map[string]int{"id": value}); err != nil {
				t.Errorf("WriteJSON(%d): %v", value, err)
			}
		}(i)
	}
	wg.Wait()

	seen := make(map[int]struct{}, writeCount)
	for i := 0; i < writeCount; i++ {
		select {
		case message := <-messageCh:
			seen[message["id"]] = struct{}{}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for concurrent WebSocket message %d", i)
		}
	}
	for i := 0; i < writeCount; i++ {
		if _, ok := seen[i]; !ok {
			t.Fatalf("missing WebSocket message id %d; got %#v", i, seen)
		}
	}
}

func TestRedactURLSecret(t *testing.T) {
	raw := "https://monitor.example.com/api?token=secret&keep=value"
	got := redactURLSecret(raw, "token")
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatalf("redacted URL should parse: %v", err)
	}
	if parsed.Query().Get("token") != "REDACTED" {
		t.Fatalf("token query = %q, want REDACTED", parsed.Query().Get("token"))
	}
	if parsed.Query().Get("keep") != "value" {
		t.Fatalf("keep query = %q, want value", parsed.Query().Get("keep"))
	}
}
