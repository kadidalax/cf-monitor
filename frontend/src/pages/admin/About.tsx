import React, { useState, useEffect } from 'react';
import { Flex, Card, Text, Heading, Badge, Grid, Box, Separator } from '@radix-ui/themes';
import { Monitor, Cloud, Database, Zap } from 'lucide-react';

interface VersionInfo {
  version: string;
  name: string;
  hash: string;
}

export default function AdminAbout() {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then(r => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="admin-about-page">
      <Flex className="admin-parent-title-row" justify="between" align="center" mb="3">
        <Heading size="5">关于</Heading>
      </Flex>

      <Card className="admin-about-card">
        <Flex direction="column" align="center" gap="3" mb="4">
          <Box style={{
            width: 80, height: 80, borderRadius: '20px',
            background: 'linear-gradient(135deg, var(--accent-9), var(--accent-10))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Monitor size={40} color="white" />
          </Box>
          <Heading size="6">CF Monitor</Heading>
          <Text size="2" color="gray">基于 Cloudflare 的服务器监控探针</Text>
          <Flex gap="2">
            <Badge size="2" color="blue">{version ? `v${version.version}` : 'v1.0.0'}</Badge>
            {version?.hash && <Badge size="2" variant="soft" color="gray">{version.hash.slice(0, 7)}</Badge>}
          </Flex>
        </Flex>

        <Separator size="4" mb="4" />

        <Grid columns="2" gap="4" mb="4">
          <Flex align="center" gap="2">
            <Cloud size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">Cloudflare Workers</Text>
              <Text size="1" color="gray">API 服务 + 前端托管</Text>
            </Flex>
          </Flex>
          <Flex align="center" gap="2">
            <Database size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">Cloudflare D1</Text>
              <Text size="1" color="gray">SQLite 数据库</Text>
            </Flex>
          </Flex>
          <Flex align="center" gap="2">
            <Zap size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">Durable Objects</Text>
              <Text size="1" color="gray">WebSocket 实时数据</Text>
            </Flex>
          </Flex>
          <Flex align="center" gap="2">
            <Monitor size={18} color="var(--accent-9)" />
            <Flex direction="column">
              <Text size="2" weight="bold">React + Radix UI</Text>
              <Text size="1" color="gray">前端界面 + Recharts</Text>
            </Flex>
          </Flex>
        </Grid>

        <Separator size="4" mb="4" />

        <Heading size="3" mb="3">特性</Heading>
        <Grid columns="2" gap="2" mb="4">
          {[
            '实时服务器资源监控',
            'CPU/内存/磁盘/网络/温度',
            '自定义 Ping 监测',
            '离线通知 (Telegram)',
            '负载阈值通知',
            '服务器分组/排序/隐藏',
            '数据备份与恢复',
            '审计日志记录',
            '暗色/亮色主题',
            '响应式设计',
            '键盘快捷键',
            '全局错误捕获',
          ].map((feature, i) => (
            <Flex key={i} align="center" gap="2">
              <Box style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: 'var(--accent-9)', flexShrink: 0 }} />
              <Text size="2">{feature}</Text>
            </Flex>
          ))}
        </Grid>

        <Separator size="4" mb="4" />

        <Heading size="3" mb="3">参考项目</Heading>
        <Text size="2" color="gray">
          本项目参考了 Komari 探针项目的设计理念，使用 Cloudflare 无服务器架构重构。
          Komari 是一个功能完善的服务器监控系统，CF Monitor 保留了其核心功能，
          并针对 Cloudflare Workers 环境进行了优化。
        </Text>
      </Card>
    </div>
  );
}
