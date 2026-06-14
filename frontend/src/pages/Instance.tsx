import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Flex, Card, Text, Badge, Heading,
  Button, Box, Tabs, SegmentedControl, IconButton
} from '@radix-ui/themes';
import {
  ArrowLeft,
  Server, Globe, Activity,
  Layers, RefreshCw, Pause
} from 'lucide-react';
import Loading from '../components/Loading';
import DetailsGrid from '../components/DetailsGrid';
import Flag from '../components/Flag';
import { useLiveData } from '../contexts/LiveDataContext';
import { normalizeListResponse, publicFetch } from '../utils/api';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, AreaChart
} from 'recharts';
import {
  buildPingChartRows,
  fetchPingTaskSeries,
  formatPingMs,
  getPingSeriesStats,
  getPingTimeDomain,
  getPingYAxisDomain,
  PingTaskSeries,
} from '../utils/pingChart';
import { buildMonitorChartData, getMonitorChartRenderData } from '../utils/monitorChartData';
import { monitorYAxisProps, monitorYAxisWidth, pingYAxisProps, pingYAxisWidth, wideYAxisProps } from '../utils/monitorChartAxis';

const formatSpeed = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
};

const formatUptime = (seconds: number): string => {
  if (!seconds || seconds < 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
};

type TimeRange = '1h' | '4h' | '24h' | '3d';
type ChartTab = 'cpu' | 'ram' | 'disk' | 'network' | 'connections' | 'process' | 'temp' | 'gpu';

const timeRangeMs: Record<TimeRange, number> = {
  '1h': 3600000,
  '4h': 14400000,
  '24h': 86400000,
  '3d': 259200000,
};

const timeRangePointLimit: Record<TimeRange, number> = {
  '1h': 240,
  '4h': 360,
  '24h': 720,
  '3d': 1000,
};

const monitorChartMargin = { top: 12, right: 16, bottom: 4, left: 4 };
const pingChartMargin = {
  ...monitorChartMargin,
  left: monitorChartMargin.left - (pingYAxisWidth - monitorYAxisWidth),
};
const monitorChartHeight = 296;
const pingChartHeight = 210;
interface ClientInfo {
  uuid: string;
  name: string;
  cpu_name: string;
  cpu_cores: number;
  virtualization: string;
  arch: string;
  os: string;
  kernel_version: string;
  gpu_name: string;
  ipv4: string;
  ipv6: string;
  has_ipv4?: boolean;
  has_ipv6?: boolean;
  region: string;
  mem_total: number;
  swap_total: number;
  disk_total: number;
  remark: string;
  public_remark?: string;
  group?: string;
  tags?: string[];
  price?: number;
  currency?: string;
  billing_cycle?: number;
  hidden?: boolean;
}

interface RecordData {
  time: string;
  cpu: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number;
  disk_total: number;
  load: number;
  temp: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number;
}

export default function Instance() {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [records, setRecords] = useState<RecordData[]>([]);
  const [clientLoading, setClientLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chartTab, setChartTab] = useState<ChartTab>('cpu');
  const [timeRange, setTimeRange] = useState<TimeRange>('1h');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [pingSeries, setPingSeries] = useState<PingTaskSeries[]>([]);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingError, setPingError] = useState<string | null>(null);
  const [gpuRecords, setGpuRecords] = useState<any[]>([]);
  const { liveData, viewerExpired } = useLiveData();
  const liveRecord = uuid ? liveData?.data?.[uuid] : undefined;
  const liveOnline = Boolean(uuid && liveData?.online?.includes(uuid));
  const onlineSet = useMemo(() => new Set(liveData?.online || []), [liveData?.online]);
  const groupedClients = useMemo(() => {
    const sorted = [...clients].sort((a, b) => {
      const aOnline = onlineSet.has(a.uuid);
      const bOnline = onlineSet.has(b.uuid);
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    const groups = new Map<string, ClientInfo[]>();
    sorted.forEach((node) => {
      const groupName = node.group?.trim() || '未分组';
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(node);
    });

    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === '未分组') return 1;
        if (b === '未分组') return -1;
        return a.localeCompare(b);
      })
      .map(([group, nodes]) => ({ group, nodes }));
  }, [clients, onlineSet]);

  // FE-1: Show viewer expired banner
  if (viewerExpired) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6 text-center">
          <h2 className="text-xl font-semibold text-yellow-900 dark:text-yellow-100 mb-2">
            查看会话已过期
          </h2>
          <p className="text-yellow-700 dark:text-yellow-300 mb-4">
            实时数据推送已停止，请刷新页面重新连接
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-yellow-600 hover:bg-yellow-700 text-white rounded-md transition-colors"
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }

  // Load public client info.
  const loadClient = useCallback(async () => {
    if (!uuid) return;
    setClientLoading(true);
    try {
      setError(null);
      const data = await publicFetch('/nodes');
      const visible = normalizeListResponse<ClientInfo>(data).filter((c) => !c.hidden);
      setClients(visible);
      const found = visible.find((c: any) => c.uuid === uuid) || null;
      if (found) { setClient(found); } else { setError('服务器不存在'); }
    } catch { setError('加载失败'); }
    finally { setClientLoading(false); }
  }, [uuid]);

  useEffect(() => { loadClient(); }, [loadClient]);

  // Load history records
  const loadRecords = useCallback(async (range: TimeRange, signal?: AbortSignal) => {
    if (!uuid) return;
    setRecordsLoading(true);
    const endTs = Date.now();
    const startTs = endTs - timeRangeMs[range];
    const start = new Date(startTs).toISOString();
    const end = new Date(endTs).toISOString();
    const limit = timeRangePointLimit[range];

    try {
      const res = await fetch(`/api/records/load?uuid=${uuid}&start=${start}&end=${end}&limit=${limit}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!signal?.aborted) {
        setRecords(normalizeListResponse<RecordData>(data));
      }
    } catch (error) {
      // Ignore AbortError on intentional cancellation
      if (signal?.aborted) return;
    } finally {
      if (!signal?.aborted) {
        setRecordsLoading(false);
      }
    }
  }, [uuid]);

  // FE-5: Add AbortController to cancel stale requests when timeRange changes
  useEffect(() => {
    const controller = new AbortController();
    loadRecords(timeRange, controller.signal);
    return () => controller.abort();
  }, [loadRecords, timeRange]);

  // Load ping tasks and records for the current node.
  useEffect(() => {
    if (!uuid) return;
    const controller = new AbortController();
    setPingSeries([]);
    setPingError(null);
    setPingLoading(true);

    fetchPingTaskSeries(uuid, { limit: 360, maxTasks: 8, rangeHours: 1, signal: controller.signal })
      .then((series) => {
        if (!controller.signal.aborted) setPingSeries(series);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPingError('加载 Ping 数据失败');
          setPingSeries([]);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPingLoading(false);
      });

    return () => controller.abort();
  }, [uuid]);

  // Load GPU records (only for GPU-capable clients)
  // FE-5: Add AbortController to cancel stale requests
  useEffect(() => {
    if (!uuid || !client?.gpu_name) return;
    const controller = new AbortController();
    const endTs = Date.now();
    const startTs = endTs - timeRangeMs[timeRange];
    const start = new Date(startTs).toISOString();
    const end = new Date(endTs).toISOString();

    fetch(`/api/records/gpu?uuid=${uuid}&start=${start}&end=${end}&limit=200`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!controller.signal.aborted) {
          setGpuRecords(normalizeListResponse<any>(data));
        }
      })
      .catch(() => {
        // Ignore AbortError on intentional cancellation
      });

    return () => controller.abort();
  }, [uuid, timeRange, client?.gpu_name]);

  // Real-time refresh comes from LiveDataContext, so the detail page does not
  // hammer D1 every 3 seconds while historical persistence is sampled at 60s.
  useEffect(() => {
    if (!uuid || !autoRefresh || !liveOnline || !liveRecord) return;
    const timestamp = liveData?.timestamp || Date.now();
    const time = new Date(timestamp).toISOString();
    setRecords(prev => {
      const last = prev.length > 0 ? prev[prev.length - 1] : null;
      if (last?.time === time) return prev;

      const livePoint = {
        ...(last || {}),
        ...liveRecord,
        time,
      } as RecordData;
      const next = [...prev.filter(record => record.time !== time), livePoint];
      return next.slice(-timeRangePointLimit[timeRange]);
    });
  }, [autoRefresh, liveData?.timestamp, liveOnline, liveRecord, timeRange, uuid]);

  const handleTimeRangeChange = (v: string) => {
    const range = v as TimeRange;
    setTimeRange(range);
    setRecordsLoading(true);
  };

  if (clientLoading || (recordsLoading && records.length === 0)) return <Loading />;
  if (error || !client) return <Text color="red" align="center" style={{ padding: 40 }}>{error || '未找到'}</Text>;

  const latestHistory = records.length > 0 ? records[records.length - 1] : null;
  const latestRecordTime = typeof (liveRecord as any)?.time === 'string'
    ? (liveRecord as any).time
    : new Date(liveData?.timestamp || Date.now()).toISOString();
  const latest = liveRecord
    ? ({
      ...(latestHistory || {}),
      ...liveRecord,
      time: latestRecordTime,
    } as RecordData)
    : latestHistory;

  const chartTimeFormatter = (value: any) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return timeRange === '24h' || timeRange === '3d'
      ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const chartData = buildMonitorChartData(records);
  const chartRenderData = getMonitorChartRenderData(chartData, timeRangeMs[timeRange], liveData?.timestamp || Date.now());

  const gpuChartData = gpuRecords.map((r: any) => ({
    time: new Date(r.time).getTime(),
    utilization: r.utilization || 0,
    memory: r.mem_total > 0 ? Number(((r.mem_used / r.mem_total) * 100).toFixed(1)) : 0,
    temp: r.temperature || 0,
  }));

  const pingSeriesWithData = pingSeries.filter((item) =>
    item.records.some((record) => Number(record.value) >= 0),
  );
  const pingChartRows = buildPingChartRows(pingSeriesWithData);
  const pingYAxisDomain = getPingYAxisDomain(pingSeriesWithData);
  const pingXAxisDomain = getPingTimeDomain(pingSeriesWithData, 1);

  return (
    <div className="instance-page">
      <div className="instance-shell">
        <InstanceNodeSidebar
          groups={groupedClients}
          activeUuid={uuid || ''}
          onlineSet={onlineSet}
          liveData={liveData?.data || {}}
          onSelect={(nextUuid) => navigate(`/instance/${nextUuid}`)}
        />

        <section className="instance-detail-panel">
      {/* Top bar */}
      <Flex justify="between" align="center" mb="4">
        <Button variant="ghost" onClick={() => navigate('/')}>
          <ArrowLeft size={16} /> 返回
        </Button>
        <Flex gap="2" align="center">
          <IconButton
            variant={autoRefresh ? 'solid' : 'ghost'}
            size="1"
            color={autoRefresh ? 'green' : 'gray'}
            onClick={() => setAutoRefresh(!autoRefresh)}
            aria-label={autoRefresh ? '暂停自动刷新' : '开启自动刷新'}
            title={autoRefresh ? '暂停自动刷新' : '开启自动刷新'}
          >
            {autoRefresh ? <RefreshCw size={14} /> : <Pause size={14} />}
          </IconButton>
        </Flex>
      </Flex>

      {/* Header + compact details */}
      <Card className="instance-top-summary" mb="3">
        <Flex align="center" gap="3" wrap="wrap" className="instance-top-summary-header">
          <Server size={26} color="var(--accent-9)" />
          <Heading size="5">{client.name}</Heading>
          {client.region && <Badge color="gray"><Globe size={12} /> {client.region}</Badge>}
          {client.group && <Badge color="purple"><Layers size={12} /> {client.group}</Badge>}
          {latest && (
            <Badge color="green" variant="solid">
              <Activity size={12} /> 已运行 {formatUptime(latest.uptime)}
            </Badge>
          )}
        </Flex>
        <DetailsGrid client={client} live={latest} compact remark={client.public_remark} />
      </Card>

      {/* Chart section */}
      <Card mb="4">
        <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
          <Text weight="bold">监控图表 · {timeRange === '1h' ? '最近1小时' : timeRange === '4h' ? '最近4小时' : timeRange === '24h' ? '最近24小时' : '最近3天'}</Text>
          <Flex align="center" gap="3" wrap="wrap">
            <SegmentedControl.Root size="1" value={timeRange} onValueChange={handleTimeRangeChange}>
              <SegmentedControl.Item value="1h">1小时</SegmentedControl.Item>
              <SegmentedControl.Item value="4h">4小时</SegmentedControl.Item>
              <SegmentedControl.Item value="24h">24小时</SegmentedControl.Item>
              <SegmentedControl.Item value="3d">3天</SegmentedControl.Item>
            </SegmentedControl.Root>
            <Text size="1" color="gray">{records.length} 个数据点</Text>
          </Flex>
        </Flex>
        <Tabs.Root value={chartTab} onValueChange={(value) => setChartTab(value as ChartTab)}>
          <Flex justify="center" className="instance-chart-tabs">
            <Tabs.List>
              <Tabs.Trigger value="cpu">CPU</Tabs.Trigger>
              <Tabs.Trigger value="ram">内存</Tabs.Trigger>
              <Tabs.Trigger value="disk">磁盘</Tabs.Trigger>
              <Tabs.Trigger value="network">网络</Tabs.Trigger>
              <Tabs.Trigger value="connections">连接数</Tabs.Trigger>
              <Tabs.Trigger value="process">进程数</Tabs.Trigger>
              <Tabs.Trigger value="temp">温度</Tabs.Trigger>
              {client.gpu_name && gpuRecords.length > 0 && (
                <Tabs.Trigger value="gpu">GPU</Tabs.Trigger>
              )}
            </Tabs.List>
          </Flex>

          <Box pt="3">
            {chartTab === 'gpu' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={gpuChartData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...monitorYAxisProps} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                  <Tooltip
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [
                      `${Number(value).toFixed(1)}${name === '温度 °C' ? ' °C' : '%'}`,
                      name,
                    ]}
                  />
                  <Line type="monotone" dataKey="utilization" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="利用率 %" />
                  <Line type="monotone" dataKey="memory" stroke="var(--green-9)" dot={false} strokeWidth={2} name="显存 %" />
                  <Line type="monotone" dataKey="temp" stroke="var(--red-9)" dot={false} strokeWidth={2} name="温度 °C" />
                </LineChart>
              </ResponsiveContainer>
            ) : chartTab === 'network' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <AreaChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...wideYAxisProps} tickFormatter={(value) => formatSpeed(Number(value))} unit="" />
                  <Tooltip
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [formatSpeed(Number(value)), name]}
                  />
                  <Area type="monotone" dataKey="net_in" stroke="var(--green-9)" fill="var(--green-3)" fillOpacity={0.32} dot={false} name="下载" />
                  <Area type="monotone" dataKey="net_out" stroke="var(--blue-9)" fill="var(--blue-3)" fillOpacity={0.32} dot={false} name="上传" />
                </AreaChart>
              </ResponsiveContainer>
            ) : chartTab === 'connections' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...wideYAxisProps} domain={['auto', 'auto']} allowDecimals={false} unit=" 个" />
                  <Tooltip
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number, name) => [Number(value).toFixed(0), name]}
                  />
                  <Line type="monotone" dataKey="connections" stroke="var(--accent-9)" dot={false} strokeWidth={2} name="TCP" />
                  <Line type="monotone" dataKey="connections_udp" stroke="var(--cyan-9)" dot={false} strokeWidth={2} name="UDP" />
                </LineChart>
              </ResponsiveContainer>
            ) : chartTab === 'process' ? (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis {...wideYAxisProps} domain={['auto', 'auto']} allowDecimals={false} unit=" 个" />
                  <Tooltip
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number) => [Number(value).toFixed(0), '进程数']}
                  />
                  <Line type="monotone" dataKey="process_count" stroke="var(--accent-9)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height={monitorChartHeight}>
                <LineChart data={chartRenderData} margin={monitorChartMargin}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                  <XAxis
                    dataKey="time"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={chartTimeFormatter}
                    fontSize={12}
                    minTickGap={28}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    {...monitorYAxisProps}
                    domain={chartTab === 'temp' ? ['auto', 'auto'] : [0, 100]}
                    tickFormatter={(value) => {
                      if (chartTab === 'temp') return `${Number(value).toFixed(0)}°C`;
                      return `${Number(value).toFixed(0)}%`;
                    }}
                  />
                  <Tooltip
                    labelFormatter={chartTimeFormatter}
                    formatter={(value: number) => {
                      if (chartTab === 'temp') return [`${Number(value).toFixed(1)} °C`, '温度'];
                      return [`${Number(value).toFixed(1)}%`, chartTab === 'cpu' ? 'CPU' : chartTab === 'ram' ? '内存' : '磁盘'];
                    }}
                  />
                  <Line type="monotone" dataKey={chartTab} stroke="var(--accent-9)" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Box>
        </Tabs.Root>
      </Card>

      {/* Ping chart */}
      <Card mb="4">
        <Flex justify="between" align="center" mb="3" gap="3" wrap="wrap">
          <Text weight="bold">Ping 延迟</Text>
          {pingSeries.length > 0 && (
            <Text size="1" color="gray">
              {pingSeriesWithData.length} / {pingSeries.length} 个任务有记录
            </Text>
          )}
        </Flex>

        {pingLoading ? (
          <Loading />
        ) : pingError ? (
          <Text size="2" color="red" align="center" style={{ display: 'block', padding: '20px' }}>
            {pingError}
          </Text>
        ) : pingSeries.length === 0 ? (
          <Text size="2" color="gray" align="center" style={{ display: 'block', padding: '20px' }}>
            暂无 Ping 任务
          </Text>
        ) : pingChartRows.length === 0 || pingSeriesWithData.length === 0 ? (
          <Text size="2" color="gray" align="center" style={{ display: 'block', padding: '20px' }}>
            暂无该节点的 Ping 记录
          </Text>
        ) : (
          <>
            <ResponsiveContainer width="100%" height={pingChartHeight}>
              <LineChart data={pingChartRows} margin={pingChartMargin}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.3} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={pingXAxisDomain}
                  tickFormatter={chartTimeFormatter}
                  fontSize={12}
                  minTickGap={28}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  {...pingYAxisProps}
                  domain={pingYAxisDomain}
                  allowDecimals={false}
                  tickFormatter={(value) => String(Math.round(Number(value)))}
                  unit=" ms"
                />
                <Tooltip
                  labelFormatter={chartTimeFormatter}
                  formatter={(value: number, name) => [
                    formatPingMs(value),
                    name,
                  ]}
                />
                {pingSeriesWithData.map((item) => (
                  <Line
                    key={item.task.key}
                    type="linear"
                    dataKey={item.task.key}
                    name={item.task.label}
                    stroke={item.task.color}
                    strokeWidth={2.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            <div className="instance-ping-series-grid">
              {pingSeriesWithData.map((item) => {
                const stats = getPingSeriesStats(item.records);
                return (
                  <div
                    key={item.task.key}
                    className="instance-ping-series-item"
                    style={{
                      borderColor: item.task.color,
                      background: `color-mix(in srgb, ${item.task.color} 9%, var(--color-panel-solid))`,
                    }}
                    title={`${item.task.type} ${item.task.target}`}
                  >
                    <Flex align="center" gap="2" style={{ minWidth: 0 }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: item.task.color,
                          flexShrink: 0,
                        }}
                      />
                      <Text size="1" weight="bold" truncate style={{ color: 'var(--gray-12)' }}>
                        {item.task.label}
                      </Text>
                    </Flex>
                    <Text size="1" color="gray" className="instance-ping-series-stat">
                      最新 {formatPingMs(stats?.latest)} · 平均 {formatPingMs(stats?.avg)} · P99 {formatPingMs(stats?.p99)}
                    </Text>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

        </section>
      </div>
    </div>
  );
}

function InstanceNodeSidebar({
  groups,
  activeUuid,
  onlineSet,
  liveData,
  onSelect,
}: {
  groups: Array<{ group: string; nodes: ClientInfo[] }>;
  activeUuid: string;
  onlineSet: Set<string>;
  liveData: Record<string, Partial<RecordData>>;
  onSelect: (uuid: string) => void;
}) {
  const total = groups.reduce((sum, group) => sum + group.nodes.length, 0);

  return (
    <aside className="instance-node-sidebar" aria-label="节点列表">
      <Card className="instance-node-sidebar-card">
        <Flex direction="column" style={{ height: '100%', minHeight: 0 }}>
          <Flex justify="between" align="center" className="instance-sidebar-header">
            <Box>
              <Text size="2" weight="bold" style={{ display: 'block' }}>节点列表</Text>
              <Text size="1" color="gray">{onlineSet.size} / {total} 在线</Text>
            </Box>
          </Flex>

          <Box className="instance-sidebar-scroll">
            {groups.map((group) => (
              <Box key={group.group}>
                <div className="instance-sidebar-group">
                  {group.group} ({group.nodes.length})
                </div>
                {group.nodes.map((node) => {
                  const isActive = node.uuid === activeUuid;
                  const isOnline = onlineSet.has(node.uuid);
                  const live = liveData[node.uuid];

                  return (
                    <button
                      key={node.uuid}
                      type="button"
                      className={`instance-sidebar-node${isActive ? ' is-active' : ''}`}
                      onClick={() => onSelect(node.uuid)}
                      title={node.name}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span
                        className={`instance-sidebar-status${isOnline ? ' is-online' : ' is-offline'}`}
                        aria-hidden="true"
                      />
                      <Flag region={node.region} size={16} />
                      <span className="instance-sidebar-node-main">
                        <span className="instance-sidebar-node-name">{node.name}</span>
                        <span className="instance-sidebar-node-meta">
                          {isOnline ? `CPU ${(live?.cpu ?? 0).toFixed(0)}%` : '离线'}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Flex>
      </Card>
    </aside>
  );
}
