import React, { useState, useEffect, useMemo } from 'react';
import { Flex, Text, Box } from '@radix-ui/themes';
import { AlertTriangle, Clock3, Globe2, RadioTower, Signal, UploadCloud } from 'lucide-react';
import Loading from '../components/Loading';
import NodeCard from '../components/NodeCard';
import NodeDisplay from '../components/NodeDisplay';
import { useLiveData } from '../contexts/LiveDataContext';
import { ClientInfo, LiveDataMap } from '../types';
import { getNodeStatsSummary } from '../utils/monitorView';
import {
  buildDashboardStatusCards,
  defaultStatusCardVisibility,
  StatusCardKey,
} from '../utils/dashboardStatus';

/* ========== Status Card Visibility (persisted in localStorage) ========== */
type StatusCardsVisibility = Record<StatusCardKey, boolean>;

const fallbackVisibility: StatusCardsVisibility = { ...defaultStatusCardVisibility };

type OfflinePosition = 'first' | 'keep' | 'last';

export const nodeCardGridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
export const mobileNodeCardGridTemplateColumns = 'repeat(2, minmax(0, 1fr))';

const nodeCardGridStyle = {
  '--node-card-grid-template-columns': nodeCardGridTemplateColumns,
  '--node-card-grid-template-columns-mobile': mobileNodeCardGridTemplateColumns,
} as React.CSSProperties;

function loadOfflinePosition(): OfflinePosition {
  try {
    const saved = localStorage.getItem('offlineServerPosition');
    if (saved === 'first' || saved === 'keep' || saved === 'last') return saved;
  } catch {}
  return 'keep';
}

const statusIconByKey: Record<StatusCardKey, React.ReactNode> = {
  currentTime: <Clock3 size={18} />,
  currentOnline: <RadioTower size={18} />,
  regionOverview: <Globe2 size={18} />,
  trafficOverview: <UploadCloud size={18} />,
  networkSpeed: <Signal size={18} />,
};

/* ========== Top Card ========== */
export function TopCard({
  title,
  value,
  detail,
  icon,
  oneLine,
  inlineValues,
  className = '',
}: {
  title: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  oneLine?: boolean;
  inlineValues?: string[];
  className?: string;
}) {
  const hasInlineValues = Boolean(inlineValues?.length);

  return (
    <Box className={`monitor-stat-card${hasInlineValues ? ' has-inline-values' : ''}${className ? ` ${className}` : ''}`}>
      <Flex className="monitor-stat-card-inner" align="center" gap="2">
        <span className="monitor-stat-icon" aria-hidden="true">{icon}</span>
        <Box className="monitor-stat-copy">
          <Flex className="monitor-stat-heading-row" align="center" gap="2">
            <Text className="monitor-stat-title" size="2">{title}</Text>
            {inlineValues ? (
              <span className="monitor-stat-inline-values">
                {inlineValues.map((item) => (
                  <span
                    key={item}
                    className={`monitor-stat-inline-value${item.startsWith('↑') ? ' is-up' : item.startsWith('↓') ? ' is-down' : ''}`}
                  >
                    {item}
                  </span>
                ))}
              </span>
            ) : (
              <Text className="monitor-stat-value" size="5" weight="bold">
                {value}
              </Text>
            )}
          </Flex>
          {!oneLine && <Text className="monitor-stat-detail" size="1">{detail}</Text>}
        </Box>
      </Flex>
    </Box>
  );
}

export function ApiUnavailableNotice({ error }: { error: string }) {
  return (
    <section className="monitor-api-alert" role="alert" aria-live="polite">
      <Flex align="start" gap="3">
        <span className="monitor-api-alert-icon" aria-hidden="true">
          <AlertTriangle size={18} />
        </span>
        <Box>
          <Text size="3" weight="bold" as="p">无法连接 Worker API</Text>
          <Text size="2" color="gray" as="p">
            请检查 Worker 是否已部署、D1 migration 是否已执行，以及本地开发时 Vite 是否正确代理到 Worker。
          </Text>
          <Text size="1" color="gray" as="p" style={{ marginTop: 6, fontFamily: 'var(--font-mono, monospace)' }}>
            {error}
          </Text>
        </Box>
      </Flex>
    </section>
  );
}

export default function Index() {
  const { liveData, loading, error } = useLiveData();
  const [now, setNow] = useState(Date.now());
  const [clients, setClients] = useState<ClientInfo[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const offlinePosition = useMemo(loadOfflinePosition, []);

  // Real-time clock
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Load client list
  useEffect(() => {
    let cancelled = false;

    const loadClients = () => {
      fetch('/api/clients')
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then(data => {
          if (!cancelled && Array.isArray(data)) {
            setClients(data.filter((c: any) => !c.hidden));
            setClientsError(null);
          }
        })
        .catch((loadError: unknown) => {
          if (!cancelled) {
            setClientsError(loadError instanceof Error ? loadError.message : '客户端列表加载失败');
          }
        })
        .finally(() => {
          if (!cancelled) setClientsLoading(false);
        });
    };

    const loadWhenVisible = () => {
      if (!document.hidden) loadClients();
    };

    loadClients();
    document.addEventListener('visibilitychange', loadWhenVisible);
    const timer = window.setInterval(loadWhenVisible, 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', loadWhenVisible);
      window.clearInterval(timer);
    };
  }, []);

  // Normalize live data for the LiveDataMap type
  const liveMap: LiveDataMap = useMemo(() => {
    if (!liveData) return { online: [], data: {} };
    return {
      online: liveData.online || [],
      data: liveData.data || {},
      clients: liveData.clients || [],
    };
  }, [liveData]);

  const stats = useMemo(() => {
    return getNodeStatsSummary(clients, liveMap);
  }, [clients, liveMap]);
  const currentTime = useMemo(() => new Date(now).toLocaleTimeString(), [now]);

  // Apply offline server position sorting
  const sortedClients = useMemo(() => {
    if (offlinePosition === 'keep') return clients;
    const onlineSet = liveMap.online;
    return [...clients].sort((a, b) => {
      const aOnline = onlineSet.includes(a.uuid);
      const bOnline = onlineSet.includes(b.uuid);
      if (aOnline === bOnline) return 0;
      if (offlinePosition === 'first') return aOnline ? 1 : -1;
      return aOnline ? -1 : 1;
    });
  }, [clients, offlinePosition, liveMap.online]);

  if (loading || clientsLoading) return <Loading />;

  const apiError = clients.length === 0 ? (clientsError || error) : null;

  const statusCards = buildDashboardStatusCards({ currentTime, ...stats });

  const renderGrid = (nodes: ClientInfo[], ld: LiveDataMap) => (
    <Box className="node-card-grid" style={nodeCardGridStyle}>
      {nodes.map(client => (
        <NodeCard
          key={client.uuid}
          client={client}
          live={ld.data[client.uuid]}
          online={ld.online.includes(client.uuid)}
        />
      ))}
    </Box>
  );

  return (
    <div className="monitor-dashboard-page">
      <section className="monitor-dashboard-hero monitor-dashboard-compact">
        <div className="monitor-stat-grid">
          {statusCards.filter(card => fallbackVisibility[card.key]).map(card => (
            <TopCard
              key={card.key}
              title={card.title}
              value={card.value}
              detail={card.detail}
              icon={statusIconByKey[card.key]}
              oneLine={card.oneLine}
              inlineValues={card.inlineValues}
              className={card.key === 'currentTime' || card.key === 'currentOnline' ? 'is-centered' : ''}
            />
          ))}
        </div>
      </section>

      {apiError && <ApiUnavailableNotice error={apiError} />}

      <NodeDisplay
        nodes={sortedClients}
        liveData={liveMap}
        gridRenderer={renderGrid}
        offlinePosition={offlinePosition}
      />
    </div>
  );
}
