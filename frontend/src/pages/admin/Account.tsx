import React, { useState } from 'react';
import { Flex, Card, Text, Heading, Button, TextField } from '@radix-ui/themes';
import { Save, User } from 'lucide-react';
import { toast } from 'sonner';
import { useApi, useAuth } from '../../contexts/AuthContext';

export default function AdminAccount() {
  const apiFetch = useApi();
  const { user } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const handleChangePassword = async () => {
    if (!oldPassword || !newPassword || !confirmPassword) {
      toast.error('请填写所有字段');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('密码长度至少 6 位');
      return;
    }

    setSaving(true);
    const result = await apiFetch('/admin/account/chpasswd', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    });
    setSaving(false);

    if (result.success) {
      toast.success('密码修改成功');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } else {
      toast.error(result.error || '修改失败');
    }
  };

  return (
    <div className="admin-account-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Flex align="center" gap="2">
          <User size={20} />
          <Heading size="5">账户设置</Heading>
        </Flex>
      </Flex>

      <Card className="admin-account-card">
        <Heading size="3" mb="3">账户信息</Heading>
        <Flex direction="column" gap="2" mb="4">
          <Flex justify="between" gap="4">
            <Text size="2" color="gray">用户名</Text>
            <Text size="2" weight="bold">{user?.username || '-'}</Text>
          </Flex>
        </Flex>

        <Heading size="3" mb="3">修改密码</Heading>
        <Flex direction="column" gap="3">
          <label>
            <Text size="2" weight="bold">旧密码</Text>
            <TextField.Root
              style={{ width: '100%', marginTop: '4px' }}
              type="password"
              value={oldPassword}
              autoComplete="current-password"
              onChange={e => setOldPassword(e.target.value)}
            />
          </label>
          <label>
            <Text size="2" weight="bold">新密码</Text>
            <TextField.Root
              style={{ width: '100%', marginTop: '4px' }}
              type="password"
              value={newPassword}
              autoComplete="new-password"
              onChange={e => setNewPassword(e.target.value)}
            />
          </label>
          <label>
            <Text size="2" weight="bold">确认新密码</Text>
            <TextField.Root
              style={{ width: '100%', marginTop: '4px' }}
              type="password"
              value={confirmPassword}
              autoComplete="new-password"
              onChange={e => setConfirmPassword(e.target.value)}
            />
          </label>
          <Button onClick={handleChangePassword} disabled={saving}>
            <Save size={16} /> {saving ? '保存中...' : '修改密码'}
          </Button>
        </Flex>
      </Card>
    </div>
  );
}
