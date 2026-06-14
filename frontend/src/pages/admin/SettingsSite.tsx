import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { Download, Save, Upload } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { SettingCard, SettingInput, SettingToggle } from '../../components/admin/SettingCard';
import { getChangedSettings, type SettingsMap } from '../../utils/settingsDiff';
import type { SettingsLayoutOutletContext } from './SettingsLayout';

const CSRF_COOKIE_NAME = 'cf_monitor_csrf';

function readCookie(name: string): string {
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

export default function SettingsSite() {
  const apiFetch = useApi();
  const { setAction } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [originalSettings, setOriginalSettings] = useState<SettingsMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch('/admin/settings?scope=site')
      .then((data) => {
        if (data && typeof data === 'object') {
          const nextSettings = data as SettingsMap;
          setSettings(nextSettings);
          setOriginalSettings(nextSettings);
        }
      })
      .finally(() => setLoading(false));
  }, [apiFetch]);

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = useCallback(async () => {
    const changedSettings = getChangedSettings(settings, originalSettings);
    if (Object.keys(changedSettings).length === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    setSaving(true);
    try {
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(changedSettings),
      });
      if (result.success) {
        setOriginalSettings((prev) => ({ ...prev, ...changedSettings }));
        toast.success('设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, originalSettings, settings]);

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={loading || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, loading, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  const downloadBackupFile = async (filename: string, backupPassword: string, reauthPassword: string) => {
    const headers: Record<string, string> = {};
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    headers['Content-Type'] = 'application/json';
    const response = await fetch('/api/admin/download/backup', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ backup_password: backupPassword, reauth_password: reauthPassword }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error || '下载失败');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadBackup = async () => {
    const password = window.prompt('请输入备份文件加密密码，至少 12 字节。恢复时必须使用同一个密码。');
    if (!password) return;
    const reauthPassword = window.prompt('请输入当前管理员密码以确认下载备份');
    if (!reauthPassword) return;

    try {
      await downloadBackupFile(`cf-monitor-encrypted-backup-${new Date().toISOString().slice(0, 10)}.json`, password, reauthPassword);
      toast.success('加密完整备份已下载，请保存好备份密码');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份下载失败');
    }
  };

  const handleUploadBackup = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const data = JSON.parse(await file.text());
      const password = window.prompt('请输入该备份文件的加密密码');
      if (!password) return;
      const beforeRestorePassword = window.prompt('恢复前会自动下载当前配置的加密备份，请设置一个临时备份密码');
      if (!beforeRestorePassword) return;
      const reauthPassword = window.prompt('请输入当前管理员密码以确认恢复备份');
      if (!reauthPassword) return;
      await downloadBackupFile(`cf-monitor-before-restore-${new Date().toISOString().slice(0, 10)}.json`, beforeRestorePassword, reauthPassword);
      const result = await apiFetch('/admin/upload/backup?confirm_restore=true&acknowledge_overwrite=true', {
        method: 'POST',
        body: JSON.stringify({
          backup: data,
          backup_password: password,
          reauth_password: reauthPassword,
          confirm_restore: true,
          acknowledge_overwrite: true,
        }),
      });

      if (!result.success) {
        toast.error(result.error || '恢复失败');
        return;
      }

      toast.success('备份已恢复');
      const nextSettings = await apiFetch('/admin/settings?scope=site');
      if (nextSettings && typeof nextSettings === 'object') {
        setSettings(nextSettings as SettingsMap);
        setOriginalSettings(nextSettings as SettingsMap);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份文件格式错误');
    } finally {
      event.target.value = '';
    }
  };

  if (loading) return <Loading />;

  return (
    <Flex direction="column" gap="4">
      <SettingCard title="基本信息" description="站点名称、描述、语言与安装脚本域名" defaultOpen>
        <SettingInput
          label="站点标题"
          description="显示在导航栏和浏览器标签页"
          value={settings.site_title || ''}
          onChange={(value) => updateSetting('site_title', value)}
          placeholder="CF Monitor"
        />
        <SettingInput
          label="站点副标题"
          description="显示在首页标题区"
          value={settings.site_subtitle || ''}
          onChange={(value) => updateSetting('site_subtitle', value)}
          placeholder="Cloudflare server monitor"
        />
        <SettingInput
          label="站点描述"
          description="用于页脚与元信息"
          value={settings.site_description || ''}
          onChange={(value) => updateSetting('site_description', value)}
          placeholder="服务器监控探针"
        />
        <SettingInput
          label="语言"
          description="界面语言设置"
          value={settings.language || 'zh-CN'}
          onChange={(value) => updateSetting('language', value)}
          placeholder="zh-CN"
        />
        <SettingInput
          label="脚本域名"
          description="生成安装命令时使用的站点地址；留空则使用当前域名"
          value={settings.script_domain || ''}
          onChange={(value) => updateSetting('script_domain', value)}
          placeholder={window.location.origin}
        />
        <SettingToggle
          label="公开隐私模式"
          description="隐藏公开 API 和面板中的地域、价格、到期、流量限制、公开备注、系统版本等运营信息"
          checked={settings.public_privacy_mode === 'true'}
          onCheckedChange={(checked) => updateSetting('public_privacy_mode', checked ? 'true' : 'false')}
        />
      </SettingCard>

      <SettingCard title="备份与恢复" description="导出或导入系统配置" defaultOpen={false}>
        <Flex direction="column" gap="3">
          <Box style={{ border: '1px solid var(--amber-6)', background: 'var(--amber-2)', borderRadius: 8, padding: 12 }}>
            <Text size="2" weight="bold" color="amber">备份包含完整敏感配置，但文件会加密</Text>
            <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>
              备份会包含节点 token、AutoDiscovery Key、Telegram 凭据和通知配置，但导出的 JSON 只保存 AES-GCM 密文。恢复时必须输入导出时设置的备份密码。
            </Text>
          </Box>
          <Text size="1" color="gray">
            导出内容包含服务器列表、系统设置、Ping 任务、离线通知和负载通知；不包含管理员账户、审计日志和历史监控数据。恢复会覆盖对应配置，并清理不存在服务器的历史记录。
          </Text>
          <Flex gap="3" wrap="wrap" mt="2">
            <Button variant="soft" onClick={handleDownloadBackup}>
              <Download size={16} /> 导出加密完整备份
            </Button>
            <div>
              <input
                type="file"
                id="backup-upload-site"
                accept=".json"
                style={{ display: 'none' }}
                onChange={handleUploadBackup}
              />
              <Button variant="soft" onClick={() => document.getElementById('backup-upload-site')?.click()}>
                <Upload size={16} /> 导入备份
              </Button>
            </div>
          </Flex>
        </Flex>
      </SettingCard>
    </Flex>
  );
}
