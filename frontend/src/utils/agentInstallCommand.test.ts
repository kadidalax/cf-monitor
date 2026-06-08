import { describe, expect, it } from 'vitest';
import {
  buildAgentInstallCommand,
  cfMonitorAgentBinaryUrl,
  defaultAgentInstallOptions,
  cfMonitorAgentScriptUrl,
  normalizeServerUrl,
} from './agentInstallCommand';

describe('CF Monitor agent install command', () => {
  it('uses this project installer URL and --server/--token args for Linux', () => {
    const command = buildAgentInstallCommand({
      platform: 'linux',
      serverUrl: 'https://worker.example.com',
      token: 'node-token',
      options: defaultAgentInstallOptions,
    });

    expect(command).toContain('/agent/install-linux.sh');
    expect(command).toContain("'--server' 'https://worker.example.com' '--token' 'node-token'");
    expect(command).toContain("'--binary-url'");
    expect(command).toContain('cf-monitor-agent-linux-amd64');
    expect(command).not.toContain('komari-monitor/komari-agent');
    expect(command).not.toContain("'-e'");
    expect(command).not.toContain("'-t'");
  });

  it('uses this project PowerShell installer and binary URL for Windows', () => {
    const command = buildAgentInstallCommand({
      platform: 'windows',
      serverUrl: 'https://worker.example.com',
      token: 'node-token',
      options: defaultAgentInstallOptions,
    });

    expect(command).toContain('install-windows.ps1');
    expect(command).toContain('cf-monitor-agent-windows-amd64.exe');
    expect(command).toContain("'-Server' 'https://worker.example.com' '-Token' 'node-token'");
    expect(command).not.toContain('komari-monitor/komari-agent');
  });

  it('passes installer-only options through to this project installer', () => {
    const command = buildAgentInstallCommand({
      platform: 'linux',
      serverUrl: 'https://worker.example.com',
      token: 'node-token',
      options: {
        ...defaultAgentInstallOptions,
        ghproxy: 'https://ghproxy.example',
        downloadProxy: '127.0.0.1:10808',
        dir: '/opt/cf-monitor',
        serviceName: 'cf-monitor-agent',
        mountInclude: '/,/data',
        mountExclude: '/boot,tmpfs',
        nicInclude: 'eth*,ens*',
        nicExclude: 'lo,docker*',
      },
    });

    expect(command).toContain("'--install-ghproxy' 'https://ghproxy.example'");
    expect(command).toContain("'--proxy' 'http://127.0.0.1:10808'");
    expect(command).toContain("'--install-dir' '/opt/cf-monitor'");
    expect(command).toContain("'--service-name' 'cf-monitor-agent'");
    expect(command).toContain("'--mount-include' '/,/data'");
    expect(command).toContain("'--mount-exclude' '/boot,tmpfs'");
    expect(command).toContain("'--nic-include' 'eth*,ens*'");
    expect(command).toContain("'--nic-exclude' 'lo,docker*'");
  });

  it('passes the download proxy to the Windows installer', () => {
    const command = buildAgentInstallCommand({
      platform: 'windows',
      serverUrl: 'https://worker.example.com',
      token: 'node-token',
      options: {
        ...defaultAgentInstallOptions,
        downloadProxy: 'http://127.0.0.1:10808',
        mountInclude: 'C:\\',
        mountExclude: 'D:\\backup',
        nicInclude: 'Ethernet*',
        nicExclude: 'Loopback*',
      },
    });

    expect(command).toContain("'-Proxy' 'http://127.0.0.1:10808'");
    expect(command).toContain("'-MountInclude' 'C:\\'");
    expect(command).toContain("'-MountExclude' 'D:\\backup'");
    expect(command).toContain("'-NicInclude' 'Ethernet*'");
    expect(command).toContain("'-NicExclude' 'Loopback*'");
  });

  it('does not expose Komari feature toggles unsupported by this Worker edition', () => {
    const command = buildAgentInstallCommand({
      platform: 'linux',
      serverUrl: 'https://worker.example.com',
      token: 'node-token',
      options: defaultAgentInstallOptions,
    });

    expect(command).not.toContain('--disable-web-ssh');
    expect(command).not.toContain('--disable-auto-update');
    expect(command).not.toContain('--ignore-unsafe-cert');
  });

  it('keeps the full project raw URL after a GitHub proxy prefix', () => {
    expect(cfMonitorAgentScriptUrl('install-linux.sh', 'https://ghproxy.example/')).toBe(
      'https://ghproxy.example/https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/cf-monitor/refs/heads/main/agent/install-linux.sh',
    );
  });

  it('builds platform-specific project binary URLs', () => {
    expect(cfMonitorAgentBinaryUrl('linux')).toContain('cf-monitor-agent-linux-amd64');
    expect(cfMonitorAgentBinaryUrl('macos')).toContain('cf-monitor-agent-darwin-amd64');
    expect(cfMonitorAgentBinaryUrl('windows')).toContain('cf-monitor-agent-windows-amd64.exe');
  });

  it('normalizes custom server domains for agent endpoint args', () => {
    expect(normalizeServerUrl('monitor.example.com/', 'https://fallback.example.com')).toBe('https://monitor.example.com');
    expect(normalizeServerUrl('', 'https://fallback.example.com/')).toBe('https://fallback.example.com');
  });
});
