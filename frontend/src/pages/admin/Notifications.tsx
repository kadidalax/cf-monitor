import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  Flex, Card, Text, Button, TextField,
  Dialog, Badge, Switch, Table, Tabs, Select,
  Box, Checkbox,
} from '@radix-ui/themes';
import { Plus, Pencil, Trash2, Search, Send, Save, Unplug, TrendingUp, Bell, CalendarClock } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { SettingCard, SettingInput, SettingToggle } from '../../components/admin/SettingCard';

const notificationTabValues = ['settings', 'offline', 'expiry', 'load'] as const;
type NotificationTab = typeof notificationTabValues[number];

function toNotificationTab(value?: string): NotificationTab {
  return notificationTabValues.includes(value as NotificationTab) ? value as NotificationTab : 'settings';
}

export default function AdminNotifications() {
  const apiFetch = useApi();
  const navigate = useNavigate();
  const { tab: urlTab } = useParams<{ tab?: string }>();
  const [activeTab, setActiveTab] = useState<NotificationTab>(() => toNotificationTab(urlTab));
  const [loading, setLoading] = useState(true);
  const [offlineNotifications, setOfflineNotifications] = useState<any[]>([]);
  const [expiryNotifications, setExpiryNotifications] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [loadNotifications, setLoadNotifications] = useState<any[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [settingsSaving, setSettingsSaving] = useState(false);

  // Offline tab state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const [batchForm, setBatchForm] = useState({ enable: true, grace_period: 180 });
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingOffline, setEditingOffline] = useState<any>(null);
  const [editForm, setEditForm] = useState({ enable: false, grace_period: 180 });
  const [expiryBatchDialogOpen, setExpiryBatchDialogOpen] = useState(false);
  const [expiryBatchForm, setExpiryBatchForm] = useState({ enable: true, advance_days: 7 });
  const [expiryEditDialogOpen, setExpiryEditDialogOpen] = useState(false);
  const [editingExpiry, setEditingExpiry] = useState<any>(null);
  const [expiryEditForm, setExpiryEditForm] = useState({ enable: false, advance_days: 7 });

  // Load tab state
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [editingLoad, setEditingLoad] = useState<any>(null);
  const [loadForm, setLoadForm] = useState<Record<string, any>>({});

  useEffect(() => {
    setActiveTab(toNotificationTab(urlTab));
  }, [urlTab]);

  const handleTabChange = (value: string) => {
    const nextTab = toNotificationTab(value);
    setActiveTab(nextTab);
    navigate(`/admin/notifications/${nextTab}`);
  };

  const loadData = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    const results = await Promise.allSettled([
      apiFetch('/admin/notification/offline'),
      apiFetch('/admin/notification/expiry'),
      apiFetch('/admin/notification/load'),
      apiFetch('/admin/clients'),
      apiFetch('/admin/settings'),
    ]);
    let failed = 0;
    const [offData, expiryData, loadRulesData, clientsData, settingsData] = results.map((result) => {
      if (result.status === 'fulfilled') return result.value;
      failed += 1;
      return null;
    });

    if (Array.isArray(offData)) setOfflineNotifications(offData);
    if (Array.isArray(expiryData)) setExpiryNotifications(expiryData);
    if (Array.isArray(loadRulesData)) setLoadNotifications(loadRulesData.map((item: any) => ({
      ...item,
      clients: Array.isArray(item.clients) ? item.clients : [],
    })));
    if (Array.isArray(clientsData)) setClients(clientsData);
    if (settingsData && typeof settingsData === 'object') setSettings(settingsData as Record<string, string>);
    if (failed > 0) {
      toast.error(`${failed} 个通知数据接口加载失败，请稍后刷新`);
    }
    setLoading(false);
  }, [apiFetch]);

  useEffect(() => { loadData(true); }, [loadData]);

  // ─── Offline: search + filter ───
  const notificationMap = useMemo(() => {
    const map = new Map<string, any>();
    offlineNotifications.forEach((n: any) => map.set(n.client, n));
    return map;
  }, [offlineNotifications]);

  const expiryNotificationMap = useMemo(() => {
    const map = new Map<string, any>();
    expiryNotifications.forEach((n: any) => map.set(n.client, n));
    return map;
  }, [expiryNotifications]);

  const filteredClients = useMemo(() => {
    if (!searchTerm.trim()) return clients;
    const term = searchTerm.toLowerCase();
    return clients.filter((c) =>
      c.name?.toLowerCase().includes(term) ||
      c.ipv4?.toLowerCase().includes(term) ||
      c.region?.toLowerCase().includes(term)
    );
  }, [clients, searchTerm]);

  // ─── Offline: toggle ───
  const toggleOffline = async (clientUuid: string, enable: boolean) => {
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable, grace_period: 180 }),
    });
    if (result.success) {
      toast.success(enable ? '已开启离线通知' : '已关闭离线通知');
      loadData();
    } else {
      toast.error('操作失败');
    }
  };

  // ─── Offline: single edit ───
  const openEditDialog = (clientUuid: string) => {
    const existing = notificationMap.get(clientUuid);
    setEditingOffline(clientUuid);
    setEditForm({
      enable: existing?.enable || false,
      grace_period: existing?.grace_period || 180,
    });
    setEditDialogOpen(true);
  };

  const saveSingleEdit = async () => {
    if (!editingOffline) return;
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify({
        client: editingOffline,
        enable: editForm.enable,
        grace_period: editForm.grace_period,
      }),
    });
    if (result.success) {
      toast.success('已更新');
      setEditDialogOpen(false);
      loadData();
    } else {
      toast.error('更新失败');
    }
  };

  // ─── Offline: batch edit ───
  const openBatchDialog = () => {
    if (selectedClients.length === 0) {
      toast.error('请先选择服务器');
      return;
    }
    setBatchForm({ enable: true, grace_period: 180 });
    setBatchDialogOpen(true);
  };

  const saveBatchEdit = async () => {
    const payload = selectedClients.map((uuid) => ({
      client: uuid,
      enable: batchForm.enable,
      grace_period: batchForm.grace_period,
    }));
    const result = await apiFetch('/admin/notification/offline/edit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.success) {
      toast.success(`已批量更新 ${selectedClients.length} 个节点`);
      setBatchDialogOpen(false);
      setSelectedClients([]);
      loadData();
    } else {
      toast.error('批量更新失败');
    }
  };

  const toggleSelectAll = () => {
    if (selectedClients.length === filteredClients.length) {
      setSelectedClients([]);
    } else {
      setSelectedClients(filteredClients.map((c) => c.uuid));
    }
  };

  const toggleExpiry = async (clientUuid: string, enable: boolean) => {
    const existing = expiryNotificationMap.get(clientUuid);
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify({ client: clientUuid, enable, advance_days: existing?.advance_days || 7 }),
    });
    if (result.success) {
      toast.success(enable ? '已开启到期通知' : '已关闭到期通知');
      loadData();
    } else {
      toast.error('操作失败');
    }
  };

  const openExpiryEditDialog = (clientUuid: string) => {
    const existing = expiryNotificationMap.get(clientUuid);
    setEditingExpiry(clientUuid);
    setExpiryEditForm({
      enable: existing?.enable || false,
      advance_days: existing?.advance_days || 7,
    });
    setExpiryEditDialogOpen(true);
  };

  const saveExpirySingleEdit = async () => {
    if (!editingExpiry) return;
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify({
        client: editingExpiry,
        enable: expiryEditForm.enable,
        advance_days: expiryEditForm.advance_days,
      }),
    });
    if (result.success) {
      toast.success('已更新');
      setExpiryEditDialogOpen(false);
      loadData();
    } else {
      toast.error('更新失败');
    }
  };

  const openExpiryBatchDialog = () => {
    if (selectedClients.length === 0) {
      toast.error('请先选择服务器');
      return;
    }
    setExpiryBatchForm({ enable: true, advance_days: 7 });
    setExpiryBatchDialogOpen(true);
  };

  const saveExpiryBatchEdit = async () => {
    const payload = selectedClients.map((uuid) => ({
      client: uuid,
      enable: expiryBatchForm.enable,
      advance_days: expiryBatchForm.advance_days,
    }));
    const result = await apiFetch('/admin/notification/expiry/edit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.success) {
      toast.success(`已批量更新 ${selectedClients.length} 个节点`);
      setExpiryBatchDialogOpen(false);
      setSelectedClients([]);
      loadData();
    } else {
      toast.error('批量更新失败');
    }
  };

  // ─── Settings: global notification channel ───
  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const saveNotificationSettings = async () => {
    setSettingsSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          ...settings,
          notification_method: 'telegram',
        }),
      });
      if (result.success) {
        toast.success('通知设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSettingsSaving(false);
    }
  };

  // ─── Load: crud ───
  const openLoadAdd = () => {
    setEditingLoad(null);
    setLoadForm({
      name: '',
      metric: 'cpu',
      threshold: 80,
      ratio: 0.8,
      interval_min: 15,
      clients: [],
      all_clients: true,
    });
    setLoadDialogOpen(true);
  };

  const openLoadEdit = (item: any) => {
    setEditingLoad(item);
    setLoadForm({
      ...item,
      all_clients: !item.clients || item.clients.length === 0,
    });
    setLoadDialogOpen(true);
  };

  const saveLoadNotification = async () => {
    const payload = {
      ...loadForm,
      clients: loadForm.all_clients ? [] : loadForm.clients || [],
    };

    if (editingLoad?.id) {
      const result = await apiFetch(`/admin/notification/load/${editingLoad.id}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        toast.success('已更新');
        setLoadDialogOpen(false);
        loadData();
      } else {
        toast.error('更新失败');
      }
    } else {
      const result = await apiFetch('/admin/notification/load/add', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        toast.success('已添加');
        setLoadDialogOpen(false);
        loadData();
      } else {
        toast.error('添加失败');
      }
    }
  };

  const deleteLoadNotification = async (id: number) => {
    const result = await apiFetch(`/admin/notification/load/${id}`, {
      method: 'DELETE',
    });
    if (result.success) {
      toast.success('已删除');
      loadData();
    } else {
      toast.error('删除失败');
    }
  };

  // ─── Test message ───
  const sendTestMessage = async () => {
    try {
      const result = await apiFetch('/admin/test/sendMessage', {
        method: 'POST',
        body: JSON.stringify({ message: 'CF Monitor 测试消息 - 通知配置成功!' }),
      });
      if (result.success) {
        toast.success('测试消息已发送');
      } else {
        toast.error(result.error || '发送失败');
      }
    } catch {
      toast.error('发送失败');
    }
  };

  if (loading) return <Loading />;

  const offlineStatsCount = offlineNotifications.filter((n: any) => n.enable).length;
  const expiryStatsCount = expiryNotifications.filter((n: any) => n.enable).length;
  const headerAction = activeTab === 'settings' ? (
    <Button onClick={saveNotificationSettings} disabled={settingsSaving}>
      <Save size={14} /> {settingsSaving ? '保存中...' : '保存设置'}
    </Button>
  ) : activeTab === 'offline' ? (
    <Button
      variant="soft"
      onClick={openBatchDialog}
      disabled={selectedClients.length === 0}
    >
      <Pencil size={14} /> 批量编辑 ({selectedClients.length})
    </Button>
  ) : activeTab === 'expiry' ? (
    <Button
      variant="soft"
      onClick={openExpiryBatchDialog}
      disabled={selectedClients.length === 0}
    >
      <Pencil size={14} /> 批量编辑 ({selectedClients.length})
    </Button>
  ) : (
    <Button onClick={openLoadAdd}><Plus size={14} /> 新建规则</Button>
  );

  return (
    <div className="admin-notifications-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <Bell size={20} />
          <Text size="5" weight="bold">通知管理</Text>
        </Flex>
      </Flex>

      <Tabs.Root value={activeTab} onValueChange={handleTabChange}>
        <Flex className="admin-subnav-action-row" justify="between" align="center" wrap="wrap" gap="3" mb="3">
          <Tabs.List className="admin-subnav-row">
            <Tabs.Trigger value="settings">
              <Bell size={14} /> 通知设置
            </Tabs.Trigger>
            <Tabs.Trigger value="offline">
              <Unplug size={14} /> 离线通知 ({offlineStatsCount} 开启)
            </Tabs.Trigger>
            <Tabs.Trigger value="expiry">
              <CalendarClock size={14} /> 到期通知 ({expiryStatsCount} 开启)
            </Tabs.Trigger>
            <Tabs.Trigger value="load">
              <TrendingUp size={14} /> 负载通知 ({loadNotifications.length} 条)
            </Tabs.Trigger>
          </Tabs.List>
          <Flex className="admin-subnav-actions" align="center" gap="2">{headerAction}</Flex>
        </Flex>

        <Box>
          {/* ─── Settings Tab ─── */}
          <Tabs.Content value="settings">
            <SettingCard title="Telegram 通知" description="配置 Telegram Bot 作为通知通道" defaultOpen>
              <SettingInput
                label="Bot Token"
                description="从 @BotFather 获取的 Telegram Bot Token"
                value={settings.telegram_bot_token || ''}
                onChange={(value) => updateSetting('telegram_bot_token', value)}
                placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
              />
              <SettingInput
                label="Chat ID"
                description="接收通知的 Telegram 群组或用户 Chat ID"
                value={settings.telegram_chat_id || ''}
                onChange={(value) => updateSetting('telegram_chat_id', value)}
                placeholder="-1001234567890"
              />
              <SettingToggle
                label="IP 变更通知"
                description="服务器 IPv4 / IPv6 发生变化时发送 Telegram 通知"
                checked={settings.enable_ip_change_notification === 'true'}
                onCheckedChange={(checked) => updateSetting('enable_ip_change_notification', checked ? 'true' : 'false')}
              />
              <SettingToggle
                label="从未上报节点告警"
                description="节点创建超过宽限期但仍没有任何上报记录时发送离线通知"
                checked={settings.offline_notify_never_reported !== 'false'}
                onCheckedChange={(checked) => updateSetting('offline_notify_never_reported', checked ? 'true' : 'false')}
              />
            </SettingCard>

            <Card style={{ padding: 16 }}>
              <Flex justify="between" align="center" gap="3" wrap="wrap">
                <Box>
                  <Text size="3" weight="bold">测试通知</Text>
                  <Text size="1" color="gray" style={{ display: 'block', marginTop: 2 }}>
                    验证 Telegram 通知配置是否可用
                  </Text>
                </Box>
                <Button variant="soft" onClick={sendTestMessage}>
                  <Send size={16} /> 发送测试消息
                </Button>
              </Flex>
            </Card>
          </Tabs.Content>

          {/* ─── Offline Tab ─── */}
          <Tabs.Content value="offline">
            <Flex justify="between" align="center" mb="3" gap="2" wrap="wrap">
              <TextField.Root
                style={{ width: 280 }}
                placeholder="搜索服务器名称、IP、地区..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              >
                <TextField.Slot><Search size={14} /></TextField.Slot>
              </TextField.Root>
            </Flex>

            {filteredClients.length === 0 ? (
              <Flex justify="center" py="6">
                <Text color="gray">暂无匹配的服务器</Text>
              </Flex>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
              <Table.Root variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell width="40px">
                      <Checkbox
                        checked={selectedClients.length === filteredClients.length && filteredClients.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>服务器</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="80px">状态</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="100px">宽限期 (秒)</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="160px">最后通知</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="132px">操作</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredClients.map((client) => {
                    const notification = notificationMap.get(client.uuid);
                    const enabled = notification?.enable || false;
                    const gracePeriod = notification?.grace_period || 180;
                    const lastNotified = notification?.last_notified;
                    const lastNotifiedText = lastNotified
                      ? new Date(lastNotified).getFullYear() < 2000
                        ? '从未触发'
                        : new Date(lastNotified).toLocaleString('zh-CN')
                      : '-';

                    return (
                      <Table.Row key={client.uuid}>
                        <Table.Cell>
                          <Checkbox
                            checked={selectedClients.includes(client.uuid)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedClients([...selectedClients, client.uuid]);
                              } else {
                                setSelectedClients(selectedClients.filter((id) => id !== client.uuid));
                              }
                            }}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2" weight="medium">{client.name || '未命名'}</Text>
                          {client.ipv4 && <Text size="1" color="gray" ml="2">{client.ipv4}</Text>}
                        </Table.Cell>
                        <Table.Cell>
                          <Switch
                            size="1"
                            checked={enabled}
                            onCheckedChange={(v) => toggleOffline(client.uuid, v)}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">{gracePeriod}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="1" color="gray">{lastNotifiedText}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Button size="1" variant="soft" onClick={() => openEditDialog(client.uuid)}>
                            <Pencil size={13} /> 编辑
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
              </div>
            )}
          </Tabs.Content>

          {/* ─── Expiry Tab ─── */}
          <Tabs.Content value="expiry">
            <Flex justify="between" align="center" mb="3" gap="2" wrap="wrap">
              <TextField.Root
                style={{ width: 280 }}
                placeholder="搜索服务器名称、IP、地区..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              >
                <TextField.Slot><Search size={14} /></TextField.Slot>
              </TextField.Root>
            </Flex>

            {filteredClients.length === 0 ? (
              <Flex justify="center" py="6">
                <Text color="gray">暂无匹配的服务器</Text>
              </Flex>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
              <Table.Root variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell width="40px">
                      <Checkbox
                        checked={selectedClients.length === filteredClients.length && filteredClients.length > 0}
                        onCheckedChange={toggleSelectAll}
                      />
                    </Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>服务器</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="80px">状态</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="110px">提前天数</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="150px">到期时间</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="160px">最后通知</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="132px">操作</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredClients.map((client) => {
                    const notification = expiryNotificationMap.get(client.uuid);
                    const enabled = notification?.enable || false;
                    const advanceDays = notification?.advance_days || 7;
                    const lastNotified = notification?.last_notified;
                    const lastNotifiedText = lastNotified
                      ? new Date(lastNotified).getFullYear() < 2000
                        ? '从未触发'
                        : new Date(lastNotified).toLocaleString('zh-CN')
                      : '-';
                    const expiredAtText = client.expired_at
                      ? new Date(client.expired_at).toLocaleDateString('zh-CN')
                      : '未设置';

                    return (
                      <Table.Row key={client.uuid}>
                        <Table.Cell>
                          <Checkbox
                            checked={selectedClients.includes(client.uuid)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                setSelectedClients([...selectedClients, client.uuid]);
                              } else {
                                setSelectedClients(selectedClients.filter((id) => id !== client.uuid));
                              }
                            }}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2" weight="medium">{client.name || '未命名'}</Text>
                          {client.ipv4 && <Text size="1" color="gray" ml="2">{client.ipv4}</Text>}
                        </Table.Cell>
                        <Table.Cell>
                          <Switch
                            size="1"
                            checked={enabled}
                            onCheckedChange={(v) => toggleExpiry(client.uuid, v)}
                          />
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">{advanceDays} 天</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="1" color={client.expired_at ? 'gray' : 'amber'}>{expiredAtText}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="1" color="gray">{lastNotifiedText}</Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Button size="1" variant="soft" onClick={() => openExpiryEditDialog(client.uuid)}>
                            <Pencil size={13} /> 编辑
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
              </div>
            )}
          </Tabs.Content>

          {/* ─── Load Tab ─── */}
          <Tabs.Content value="load">
            {loadNotifications.length === 0 ? (
              <Flex justify="center" py="6" direction="column" align="center" gap="2">
                <TrendingUp size={32} color="var(--gray-6)" />
                <Text color="gray">暂无负载通知规则</Text>
                <Button variant="soft" size="1" onClick={openLoadAdd}><Plus size={14} /> 新建规则</Button>
              </Flex>
            ) : (
              <div style={{ maxHeight: 'calc(100vh - 320px)', overflow: 'auto' }}>
              <Table.Root variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell width="280px">名称</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="90px">指标</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="90px">阈值</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="90px">达标率</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="100px">监测间隔</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="100px">范围</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell width="132px">操作</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {loadNotifications.map((item: any) => (
                    <Table.Row key={item.id}>
                      <Table.Cell style={{ maxWidth: 280 }}>
                        <Text
                          size="2"
                          weight="medium"
                          style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {item.name || '未命名规则'}
                        </Text>
                      </Table.Cell>
                      <Table.Cell><Badge variant="soft" size="1">{item.metric || 'cpu'}</Badge></Table.Cell>
                      <Table.Cell><Text size="2">{item.threshold || 80}%</Text></Table.Cell>
                      <Table.Cell><Text size="2">{((item.ratio || 0.8) * 100).toFixed(0)}%</Text></Table.Cell>
                      <Table.Cell><Text size="2">{item.interval_min || 15} min</Text></Table.Cell>
                      <Table.Cell>
                        <Badge variant="soft" size="1" color={item.all_clients || !item.clients || item.clients.length === 0 ? 'blue' : 'amber'}>
                          {item.all_clients || !item.clients || item.clients.length === 0 ? '全节点' : `${item.clients?.length || 0} 节点`}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex gap="1" wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>
                          <Button size="1" variant="soft" onClick={() => openLoadEdit(item)}>
                            <Pencil size={13} /> 编辑
                          </Button>
                          <Button size="1" variant="soft" color="red" onClick={() => deleteLoadNotification(item.id)}>
                            <Trash2 size={13} /> 删除
                          </Button>
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
              </div>
            )}
          </Tabs.Content>
        </Box>
      </Tabs.Root>

      {/* ─── Offline Single Edit Dialog ─── */}
      <Dialog.Root open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>编辑离线通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            {editingOffline && (
              <Text size="2">{clients.find((c) => c.uuid === editingOffline)?.name || editingOffline}</Text>
            )}
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={editForm.enable} onCheckedChange={(v) => setEditForm({ ...editForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{editForm.enable ? '已开启' : '已关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">宽限期 (秒)</Text>
              <TextField.Root
                type="number"
                value={editForm.grace_period}
                onChange={(e) => setEditForm({ ...editForm, grace_period: Number(e.target.value) })}
                mt="1"
              />
              <Text size="1" color="gray" mt="1">
                服务器离线超过该时间后才会发送通知，避免网络抖动误报
              </Text>
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setEditDialogOpen(false)}>取消</Button>
            <Button onClick={saveSingleEdit}>保存</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Batch Edit Dialog ─── */}
      <Dialog.Root open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>批量编辑离线通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            将为 {selectedClients.length} 个选中节点统一设置离线通知参数
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={batchForm.enable} onCheckedChange={(v) => setBatchForm({ ...batchForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{batchForm.enable ? '开启' : '关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">宽限期 (秒)</Text>
              <TextField.Root
                type="number"
                value={batchForm.grace_period}
                onChange={(e) => setBatchForm({ ...batchForm, grace_period: Number(e.target.value) })}
                mt="1"
              />
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setBatchDialogOpen(false)}>取消</Button>
            <Button onClick={saveBatchEdit}>保存 ({selectedClients.length} 节点)</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Expiry Single Edit Dialog ─── */}
      <Dialog.Root open={expiryEditDialogOpen} onOpenChange={setExpiryEditDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>编辑到期通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            {editingExpiry && (
              <Text size="2">{clients.find((c) => c.uuid === editingExpiry)?.name || editingExpiry}</Text>
            )}
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={expiryEditForm.enable} onCheckedChange={(v) => setExpiryEditForm({ ...expiryEditForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{expiryEditForm.enable ? '已开启' : '已关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">提前天数</Text>
              <TextField.Root
                type="number"
                min="1"
                max="365"
                value={expiryEditForm.advance_days}
                onChange={(e) => setExpiryEditForm({ ...expiryEditForm, advance_days: Number(e.target.value) })}
                mt="1"
              />
              <Text size="1" color="gray" mt="1">
                节点到期前进入该天数窗口时发送一次提醒
              </Text>
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setExpiryEditDialogOpen(false)}>取消</Button>
            <Button onClick={saveExpirySingleEdit}>保存</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Expiry Batch Edit Dialog ─── */}
      <Dialog.Root open={expiryBatchDialogOpen} onOpenChange={setExpiryBatchDialogOpen}>
        <Dialog.Content style={{ maxWidth: 420 }}>
          <Dialog.Title>批量编辑到期通知</Dialog.Title>
          <Dialog.Description size="2" mb="3">
            将为 {selectedClients.length} 个选中节点统一设置到期提醒参数
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">状态</Text>
              <Flex mt="1">
                <Switch checked={expiryBatchForm.enable} onCheckedChange={(v) => setExpiryBatchForm({ ...expiryBatchForm, enable: v })} />
                <Text size="2" ml="2" color="gray">{expiryBatchForm.enable ? '开启' : '关闭'}</Text>
              </Flex>
            </label>
            <label>
              <Text size="2" weight="bold">提前天数</Text>
              <TextField.Root
                type="number"
                min="1"
                max="365"
                value={expiryBatchForm.advance_days}
                onChange={(e) => setExpiryBatchForm({ ...expiryBatchForm, advance_days: Number(e.target.value) })}
                mt="1"
              />
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setExpiryBatchDialogOpen(false)}>取消</Button>
            <Button onClick={saveExpiryBatchEdit}>保存 ({selectedClients.length} 节点)</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {/* ─── Load Add/Edit Dialog ─── */}
      <Dialog.Root open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <Dialog.Content style={{ maxWidth: 480 }}>
          <Dialog.Title>{editingLoad ? '编辑负载通知规则' : '新建负载通知规则'}</Dialog.Title>
          <Flex direction="column" gap="3">
            <label>
              <Text size="2" weight="bold">规则名称</Text>
              <TextField.Root
                placeholder="CPU 高负载告警"
                value={loadForm.name || ''}
                onChange={(e) => setLoadForm({ ...loadForm, name: e.target.value })}
                mt="1"
              />
            </label>
            <label>
              <Text size="2" weight="bold">监测指标</Text>
              <Select.Root value={loadForm.metric || 'cpu'} onValueChange={(v) => setLoadForm({ ...loadForm, metric: v })}>
                <Select.Trigger style={{ width: '100%', marginTop: 4 }} />
                <Select.Content>
                  <Select.Item value="cpu">CPU 使用率</Select.Item>
                  <Select.Item value="ram">内存使用率</Select.Item>
                  <Select.Item value="load">系统负载</Select.Item>
                  <Select.Item value="disk">磁盘使用率</Select.Item>
                  <Select.Item value="temp">温度</Select.Item>
                </Select.Content>
              </Select.Root>
            </label>
            <Flex gap="3">
              <label style={{ flex: 1 }}>
                <Text size="2" weight="bold">阈值 (%)</Text>
                <TextField.Root
                  type="number"
                  value={loadForm.threshold || 80}
                  onChange={(e) => setLoadForm({ ...loadForm, threshold: Number(e.target.value) })}
                  mt="1"
                />
              </label>
              <label style={{ flex: 1 }}>
                <Text size="2" weight="bold">达标率</Text>
                <TextField.Root
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={loadForm.ratio || 0.8}
                  onChange={(e) => setLoadForm({ ...loadForm, ratio: Number(e.target.value) })}
                  mt="1"
                />
                <Text size="1" color="gray">
                  监测窗口内超标采样比例，0.8 表示 80% 采样超标时触发
                </Text>
              </label>
            </Flex>
            <label>
              <Text size="2" weight="bold">监测间隔 (分钟)</Text>
              <TextField.Root
                type="number"
                min={1}
                max={240}
                value={loadForm.interval_min || 15}
                onChange={(e) => setLoadForm({ ...loadForm, interval_min: Number(e.target.value) })}
                mt="1"
              />
            </label>
            <label>
              <Flex align="center" gap="2">
                <Switch
                  checked={loadForm.all_clients === true}
                  onCheckedChange={(v) => setLoadForm({ ...loadForm, all_clients: v })}
                />
                <Text size="2" weight="bold">应用到所有服务器</Text>
              </Flex>
            </label>
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Button variant="soft" color="gray" onClick={() => setLoadDialogOpen(false)}>取消</Button>
            <Button onClick={saveLoadNotification}>{editingLoad ? '保存' : '创建'}</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
