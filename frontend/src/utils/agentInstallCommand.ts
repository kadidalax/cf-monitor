import { CF_MONITOR_REPOSITORY } from './projectLinks';

export type AgentInstallPlatform = 'linux' | 'windows' | 'macos';

export type AgentInstallOptions = {
  ghproxy: string;
  downloadProxy: string;
  dir: string;
  serviceName: string;
  binaryUrl?: string;
  mountInclude: string;
  mountExclude: string;
  nicInclude: string;
  nicExclude: string;
};

export const defaultAgentInstallOptions: AgentInstallOptions = {
  ghproxy: '',
  downloadProxy: '',
  dir: '',
  serviceName: '',
  binaryUrl: '',
  mountInclude: '',
  mountExclude: '',
  nicInclude: '',
  nicExclude: '',
};

export const CF_MONITOR_BRANCH = 'main';
export const CF_MONITOR_RELEASE_TAG = 'latest';
export const CF_MONITOR_AGENT_SCRIPT_BASE = `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/${CF_MONITOR_BRANCH}/agent`;
export const CF_MONITOR_RELEASE_BASE = `https://github.com/${CF_MONITOR_REPOSITORY}/releases/${CF_MONITOR_RELEASE_TAG}/download`;

export function normalizeServerUrl(value: string, fallback: string) {
  const raw = value.trim() || fallback;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/g, '');
}

export function normalizeProxyUrl(value: string) {
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/g, '');
}

export function proxiedUrl(url: string, ghproxy = '') {
  const proxy = normalizeProxyUrl(ghproxy);
  if (!proxy) return url;
  return `${proxy}/${url}`;
}

export function cfMonitorAgentScriptUrl(scriptFile: 'install-linux.sh' | 'install-windows.ps1', ghproxy = '') {
  return proxiedUrl(`${CF_MONITOR_AGENT_SCRIPT_BASE}/${scriptFile}`, ghproxy);
}

export function cfMonitorAgentBinaryUrl(platform: AgentInstallPlatform, ghproxy = '') {
  const file = platform === 'windows'
    ? 'cf-monitor-agent-windows-amd64.exe'
    : platform === 'macos'
      ? 'cf-monitor-agent-darwin-amd64'
      : 'cf-monitor-agent-linux-amd64';
  return proxiedUrl(`${CF_MONITOR_RELEASE_BASE}/${file}`, ghproxy);
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function psQuote(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function buildAgentInstallCommand({
  platform,
  serverUrl,
  token,
  options,
  instanceId,
}: {
  platform: AgentInstallPlatform;
  serverUrl: string;
  token: string;
  options: AgentInstallOptions;
  instanceId?: string;
}) {
  const ghproxy = normalizeProxyUrl(options.ghproxy);
  const downloadProxy = normalizeProxyUrl(options.downloadProxy);
  const binaryUrl = options.binaryUrl?.trim();
  const dir = options.dir.trim();
  const serviceName = options.serviceName.trim();
  const effectiveInstanceId = instanceId?.trim() || token || '<TOKEN>';
  const mountInclude = options.mountInclude.trim();
  const mountExclude = options.mountExclude.trim();
  const nicInclude = options.nicInclude.trim();
  const nicExclude = options.nicExclude.trim();

  switch (platform) {
    case 'linux': {
      const args = ['--server', serverUrl, '--token', token || '<TOKEN>'];
      if (!dir && !serviceName) args.push('--instance-id', effectiveInstanceId);
      if (binaryUrl) args.push('--binary-url', binaryUrl);
      if (ghproxy) args.push('--install-ghproxy', ghproxy);
      if (downloadProxy) args.push('--proxy', downloadProxy);
      if (dir) args.push('--install-dir', dir);
      if (serviceName) args.push('--service-name', serviceName);
      if (mountInclude) args.push('--mount-include', mountInclude);
      if (mountExclude) args.push('--mount-exclude', mountExclude);
      if (nicInclude) args.push('--nic-include', nicInclude);
      if (nicExclude) args.push('--nic-exclude', nicExclude);
      return `wget -qO- ${shellQuote(cfMonitorAgentScriptUrl('install-linux.sh', ghproxy))} | sudo bash -s -- ${args.map(shellQuote).join(' ')}`;
    }
    case 'windows': {
      const args = ['-Server', serverUrl, '-Token', token || '<TOKEN>'];
      if (!dir && !serviceName) args.push('-InstanceId', effectiveInstanceId);
      if (binaryUrl) args.push('-BinaryUrl', binaryUrl);
      if (ghproxy) args.push('-InstallGhproxy', ghproxy);
      if (downloadProxy) args.push('-Proxy', downloadProxy);
      if (dir) args.push('-InstallDir', dir);
      if (serviceName) args.push('-ServiceName', serviceName);
      if (mountInclude) args.push('-MountInclude', mountInclude);
      if (mountExclude) args.push('-MountExclude', mountExclude);
      if (nicInclude) args.push('-NicInclude', nicInclude);
      if (nicExclude) args.push('-NicExclude', nicExclude);
      return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
        `"iwr ${psQuote(cfMonitorAgentScriptUrl('install-windows.ps1', ghproxy))} -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\\install-windows.ps1' ${args.map(psQuote).join(' ')}"`;
    }
    case 'macos': {
      const args = ['--server', serverUrl, '--token', token || '<TOKEN>'];
      if (!dir && !serviceName) args.push('--instance-id', effectiveInstanceId);
      if (binaryUrl) args.push('--binary-url', binaryUrl);
      if (ghproxy) args.push('--install-ghproxy', ghproxy);
      if (downloadProxy) args.push('--proxy', downloadProxy);
      if (dir) args.push('--install-dir', dir);
      if (serviceName) args.push('--service-name', serviceName);
      if (mountInclude) args.push('--mount-include', mountInclude);
      if (mountExclude) args.push('--mount-exclude', mountExclude);
      if (nicInclude) args.push('--nic-include', nicInclude);
      if (nicExclude) args.push('--nic-exclude', nicExclude);
      return `zsh <(curl -sL ${shellQuote(cfMonitorAgentScriptUrl('install-linux.sh', ghproxy))}) ${args.map(shellQuote).join(' ')}`;
    }
    default:
      return '';
  }
}

export function buildAgentUninstallAllCommand({
  platform,
  ghproxy = '',
}: {
  platform: AgentInstallPlatform;
  ghproxy?: string;
}) {
  const proxy = normalizeProxyUrl(ghproxy);
  switch (platform) {
    case 'windows':
      return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
        `"iwr ${psQuote(cfMonitorAgentScriptUrl('install-windows.ps1', proxy))} -UseBasicParsing -OutFile 'install-windows.ps1'; & '.\\install-windows.ps1' '-UninstallAll' '-Yes'"`;
    case 'macos':
      return `zsh <(curl -sL ${shellQuote(cfMonitorAgentScriptUrl('install-linux.sh', proxy))}) '--uninstall-all' '--yes'${proxy ? ` '--install-ghproxy' ${shellQuote(proxy)}` : ''}`;
    case 'linux':
    default:
      return `wget -qO- ${shellQuote(cfMonitorAgentScriptUrl('install-linux.sh', proxy))} | sudo bash -s -- '--uninstall-all' '--yes'${proxy ? ` '--install-ghproxy' ${shellQuote(proxy)}` : ''}`;
  }
}

export const buildKomariAgentInstallCommand = buildAgentInstallCommand;
export const komariAgentScriptUrl = cfMonitorAgentScriptUrl;
