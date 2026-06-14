import { useEffect, useMemo, useState } from 'react';
import {
  Flex,
  Card,
  Text,
  Heading,
  Badge,
  Table,
  Select,
  TextField,
  Box,
  Button,
  Dialog,
} from '@radix-ui/themes';
import { ScrollText, Search, Shield, Clock3, User, FileText } from 'lucide-react';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';

interface LogEntry {
  user?: string | null;
  id: number;
  action?: string | null;
  detail?: string | null;
  level?: string | null;
  time: string;
}

const actionLabels: Record<string, { label: string; color: string }> = {
  login: { label: '登录', color: 'green' },
  login_failed: { label: '登录失败', color: 'orange' },
  csrf_rejected: { label: 'CSRF 拒绝', color: 'red' },
  reauth_failed: { label: '重认证失败', color: 'red' },
  account_username_edit: { label: '修改用户名', color: 'orange' },
  client_add: { label: '添加服务器', color: 'blue' },
  client_edit: { label: '编辑服务器', color: 'blue' },
  client_remove: { label: '删除服务器', color: 'red' },
  client_batch_remove: { label: '批量删除服务器', color: 'red' },
  client_batch_hide: { label: '批量隐藏服务器', color: 'orange' },
  client_reorder: { label: '服务器排序', color: 'blue' },
  client_token_view_blocked: { label: 'Token 查看拒绝', color: 'orange' },
  client_token_rotate: { label: '重置 Token', color: 'red' },
  chpasswd: { label: '修改密码', color: 'orange' },
  settings_save: { label: '保存设置', color: 'blue' },
  settings_edit: { label: '修改设置', color: 'blue' },
  ping_add: { label: '添加 Ping', color: 'blue' },
  ping_edit: { label: '编辑 Ping', color: 'blue' },
  ping_delete: { label: '删除 Ping', color: 'red' },
  offline_notification_edit: { label: '离线通知', color: 'orange' },
  load_notification_add: { label: '负载通知', color: 'blue' },
  load_notification_edit: { label: '编辑负载', color: 'blue' },
  load_notification_delete: { label: '删除负载', color: 'red' },
  record_clear: { label: '清除记录', color: 'red' },
  record_clear_all: { label: '清除全部', color: 'red' },
  backup_download: { label: '下载备份', color: 'purple' },
  backup_restore: { label: '恢复备份', color: 'purple' },
  maintenance_cleanup: { label: '手动清理', color: 'orange' },
  maintenance_cleanup_error: { label: '清理失败', color: 'red' },
  cron_cleanup: { label: '定时清理', color: 'gray' },
  offline_notify: { label: '离线告警', color: 'red' },
  offline_recovery_notify: { label: '离线恢复', color: 'green' },
  expiry_notify: { label: '到期提醒', color: 'orange' },
  load_notify: { label: '负载告警', color: 'red' },
  load_recovery_notify: { label: '负载恢复', color: 'green' },
  ip_change: { label: 'IP 变更', color: 'orange' },
  init: { label: '系统初始化', color: 'gray' },
};

const highRiskActions = new Set([
  'backup_download',
  'backup_restore',
  'chpasswd',
  'client_remove',
  'client_batch_remove',
  'client_token_rotate',
  'maintenance_cleanup',
  'ping_delete',
  'record_clear',
  'record_clear_all',
]);

const auditTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function formatAuditTime(time: string) {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? '-' : auditTimeFormatter.format(date);
}

export function getAuditLogDetailText(detail: unknown) {
  return typeof detail === 'string' && detail.trim() ? detail : '-';
}

export function formatAuditLogDetailPreview(detail: unknown, maxLength = 120) {
  const text = getAuditLogDetailText(detail);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function SummaryCards({
  logs,
}: {
  logs: LogEntry[];
}) {
  const userCount = new Set(logs.map((log) => log.user).filter(Boolean)).size;
  const highRiskCount = logs.filter((log) =>
    highRiskActions.has(log.action || ''),
  ).length;
  const todayCount = logs.filter((log) => {
    const now = new Date();
    const date = new Date(log.time);
    return now.toDateString() === date.toDateString();
  }).length;

  const cards = [
    { title: '当前页日志', value: String(logs.length), icon: <FileText size={16} />, color: 'var(--blue-9)' },
    { title: '活跃用户', value: String(userCount), icon: <User size={16} />, color: 'var(--cyan-9)' },
    { title: '今日操作', value: String(todayCount), icon: <Clock3 size={16} />, color: 'var(--green-9)' },
    { title: '高风险动作', value: String(highRiskCount), icon: <Shield size={16} />, color: 'var(--red-9)' },
  ];

  return (
    <Flex className="audit-summary-action-row" justify="between" align="center" wrap="wrap" gap="3">
      <div className="audit-summary-strip">
        {cards.map((card) => (
          <div className="audit-summary-item" key={card.title}>
            <span className="audit-summary-icon" style={{ color: card.color }} aria-hidden="true">{card.icon}</span>
            <Text className="audit-summary-label" size="1" color="gray">{card.title}</Text>
            <Text className="audit-summary-value" size="3" weight="bold">{card.value}</Text>
          </div>
        ))}
      </div>
    </Flex>
  );
}

export default function AdminAuditLogs() {
  const apiFetch = useApi();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState('50');
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/admin/logs?limit=${pageSize}&page=${page}`)
      .then(data => {
        if (cancelled) return;
        if (data && typeof data === 'object') {
          if (Array.isArray((data as any).data)) setLogs((data as any).data);
          setTotal(Number((data as any).total || 0));
          setHasMore(Boolean((data as any).has_more));
        }
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setLogs([]);
        setTotal(0);
        setHasMore(false);
        setError(loadError instanceof Error ? loadError.message : '审计日志加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, page, pageSize]);

  const filteredLogs = useMemo(() => {
    return logs.filter(log => {
      if (filter !== 'all' && log.action !== filter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          log.action?.toLowerCase().includes(q) ||
          log.detail?.toLowerCase().includes(q) ||
          log.user?.toLowerCase().includes(q) ||
          String(log.id).includes(q)
        );
      }
      return true;
    });
  }, [logs, filter, search]);

  const uniqueActions = Array.from(new Set(logs.map(l => l.action).filter((action): action is string => Boolean(action))));
  const knownPages = Math.max(page, Math.ceil(total / Number(pageSize || 50)));
  const pageLabel = hasMore ? `第 ${page} 页，至少 ${total} 条` : `第 ${page} / ${knownPages} 页，共 ${total} 条`;

  if (loading) return <Loading />;

  return (
    <div>
      <Flex className="admin-audit-page" direction="column" gap="2">
        <Flex className="admin-parent-title-row" align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <ScrollText size={20} />
            <Heading size="5">审计日志</Heading>
          </Flex>
        </Flex>

        <SummaryCards
          logs={logs}
        />

        {error && (
          <Card className="admin-error-card">
            <Text size="2" color="red" weight="bold">审计日志加载失败</Text>
            <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>{error}</Text>
          </Card>
        )}

        <Card className="audit-filter-card">
          <Flex className="audit-filter-toolbar" gap="3" align="center" wrap="wrap">
            <div className="audit-search-field">
              <Box className="audit-search-icon">
                <Search size={16} />
              </Box>
              <TextField.Root
                className="audit-search-input"
                placeholder="搜索日志"
                value={search}
                onChange={e => setSearch((e.target as HTMLInputElement).value)}
              />
            </div>

            <Select.Root value={filter} onValueChange={setFilter}>
              <Select.Trigger className="audit-action-filter" aria-label="操作筛选" />
              <Select.Content>
                <Select.Item value="all">全部</Select.Item>
                {uniqueActions.map(action => (
                  <Select.Item key={action} value={action}>
                    {actionLabels[action]?.label || action}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>

            <Select.Root value={pageSize} onValueChange={(value) => { setPage(1); setPageSize(value); }}>
              <Select.Trigger className="audit-page-size-select" aria-label="每页条数" />
              <Select.Content>
                <Select.Item value="20">20 条</Select.Item>
                <Select.Item value="50">50 条</Select.Item>
                <Select.Item value="100">100 条</Select.Item>
              </Select.Content>
            </Select.Root>

            <Badge className="audit-filter-result" variant="soft" color="blue">本页筛选结果 {filteredLogs.length}</Badge>
          </Flex>
        </Card>

        <Card className="audit-table-card">
          <Table.Root className="audit-log-table">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell className="audit-log-id-header" style={{ width: '84px' }}>ID</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="audit-log-time-header" style={{ width: '170px' }}>时间</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="audit-log-user-header" style={{ width: '120px' }}>用户</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="audit-log-action-header" style={{ width: '140px' }}>操作</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell className="audit-log-detail-header">详情</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {filteredLogs.map(log => {
                const actionInfo = log.action ? actionLabels[log.action] : undefined;
                return (
                  <Table.Row
                    className="audit-log-row"
                    key={log.id}
                  >
                    <Table.Cell
                      className="audit-log-id-cell"
                    >
                      <Button variant="ghost" size="1" onClick={() => setSelectedLog(log)}>
                        {log.id}
                      </Button>
                    </Table.Cell>
                    <Table.Cell className="audit-log-time-cell">
                      <Text size="1" style={{ fontFamily: 'monospace' }}>
                        {formatAuditTime(log.time)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell className="audit-log-user-cell">
                      <Text size="1">{log.user || '-'}</Text>
                    </Table.Cell>
                    <Table.Cell className="audit-log-action-cell">
                      <Badge size="1" variant="soft" color={(actionInfo?.color as any) || 'gray'}>
                        {actionInfo?.label || log.action || '-'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell className="audit-log-detail-cell">
                      <button
                        type="button"
                        className="audit-detail-preview"
                        title={getAuditLogDetailText(log.detail)}
                        aria-label={`查看日志 ${log.id} 详情`}
                        onClick={() => setSelectedLog(log)}
                      >
                        <Text
                          className="audit-detail-preview-text"
                          size="1"
                          color="gray"
                          as="span"
                        >
                          {formatAuditLogDetailPreview(log.detail, 240)}
                        </Text>
                      </button>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
          {filteredLogs.length === 0 && (
            <Text color="gray" align="center" style={{ padding: '20px', display: 'block' }}>
              {search || filter !== 'all' ? '没有匹配的日志' : '暂无日志记录'}
            </Text>
          )}
        </Card>

        <Flex justify="between" align="center" wrap="wrap" gap="3">
          <Text size="2" color="gray">
            {pageLabel}
          </Text>
          <Flex gap="2">
            <Button variant="soft" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              上一页
            </Button>
            <Button variant="soft" disabled={!hasMore} onClick={() => setPage((value) => value + 1)}>
              下一页
            </Button>
          </Flex>
        </Flex>
      </Flex>

      <Dialog.Root open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <Dialog.Content className="audit-log-dialog" style={{ maxWidth: 620 }}>
          <Dialog.Title>日志详情</Dialog.Title>
          {selectedLog && (
            <>
              <div className="audit-detail-card">
                <div className="audit-detail-header">
                  <span className="audit-detail-icon" aria-hidden="true">
                    <ScrollText size={18} />
                  </span>
                  <div className="audit-detail-heading">
                    <Badge variant="soft" color={(selectedLog.action ? actionLabels[selectedLog.action]?.color as any : undefined) || 'gray'}>
                      {selectedLog.action ? actionLabels[selectedLog.action]?.label || selectedLog.action : '-'}
                    </Badge>
                    <Text className="audit-detail-time" size="1" color="gray">{formatAuditTime(selectedLog.time)}</Text>
                  </div>
                  <Badge className="audit-detail-id" variant="soft" color="gray">#{selectedLog.id}</Badge>
                </div>

                <div className="audit-detail-meta-grid">
                  <div className="audit-detail-meta-item">
                    <Text className="audit-detail-meta-label" size="1" color="gray">用户</Text>
                    <Text className="audit-detail-meta-value" size="2">{selectedLog.user || '-'}</Text>
                  </div>
                  <div className="audit-detail-meta-item">
                    <Text className="audit-detail-meta-label" size="1" color="gray">级别</Text>
                    <Text className="audit-detail-meta-value" size="2">{selectedLog.level || 'info'}</Text>
                  </div>
                  <div className="audit-detail-meta-item audit-detail-meta-item-wide">
                    <Text className="audit-detail-meta-label" size="1" color="gray">动作</Text>
                    <Text className="audit-detail-meta-value" size="2">{selectedLog.action || '-'}</Text>
                  </div>
                </div>

                <div className="audit-detail-section">
                  <Text className="audit-detail-section-title" size="2" weight="bold">详情</Text>
                  <pre className="audit-detail-body">{getAuditLogDetailText(selectedLog.detail)}</pre>
                </div>
              </div>

              <Flex justify="end" mt="3">
                <Button variant="soft" onClick={() => setSelectedLog(null)}>关闭</Button>
              </Flex>
            </>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
