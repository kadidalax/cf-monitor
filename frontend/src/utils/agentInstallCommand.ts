import { CF_MONITOR_REPOSITORY } from './projectLinks';

export type AgentInstallPlatform = 'linux' | 'windows' | 'macos';

export type AgentInstallOptions = {
  ghproxy: string;
  downloadProxy: string;
  dir: string;
  serviceName: string;
  binaryUrl?: string;
  binarySha256?: string;
  checksumUrl?: string;
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
  binarySha256: '',
  checksumUrl: '',
  mountInclude: '',
  mountExclude: '',
  nicInclude: '',
  nicExclude: '',
};

const CF_MONITOR_BRANCH = 'main';
const CF_MONITOR_AGENT_SCRIPT_BASE = `https://raw.githubusercontent.com/${CF_MONITOR_REPOSITORY}/refs/heads/${CF_MONITOR_BRANCH}/agent`;

export function normalizeServerUrl(value: string, fallback: string) {
  const raw = value.trim() || fallback;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/g, '');
}

function normalizeProxyUrl(value: string) {
  const raw = value.trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/g, '');
}

function proxiedUrl(url: string, ghproxy = '') {
  const proxy = normalizeProxyUrl(ghproxy);
  if (!proxy) return url;
  return `${proxy}/${url}`;
}

function cfMonitorAgentScriptUrl(scriptFile: 'install-linux.sh' | 'install-windows.ps1', ghproxy = '') {
  return proxiedUrl(`${CF_MONITOR_AGENT_SCRIPT_BASE}/${scriptFile}`, ghproxy);
}

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function psQuote(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function rootAwareBashPipe(downloadCommand: string, args: string[]) {
  const quotedArgs = args.map(shellQuote).join(' ');
  return `${downloadCommand} | { SUDO=; [ "$(id -u)" -eq 0 ] || SUDO=sudo; $SUDO bash -s -- ${quotedArgs}; }`;
}

function rootAwareBashInstall(scriptUrl: string, downloader: 'wget' | 'curl', args: string[]) {
  const quotedUrl = shellQuote(scriptUrl);
  const quotedArgs = args.map(shellQuote).join(' ');
  const downloadCommand = downloader === 'wget'
    ? `wget -qO "$tmp" ${quotedUrl}`
    : `curl -fsSL ${quotedUrl} -o "$tmp"`;
  return `tmp=$(mktemp) && ${downloadCommand} && { SUDO=; [ "$(id -u)" -eq 0 ] || SUDO=sudo; [ -z "$SUDO" ] || $SUDO -v; read -r -s -p 'CF Monitor token: ' CF_MONITOR_TOKEN; echo; printf '%s\\n' "$CF_MONITOR_TOKEN" | $SUDO bash "$tmp" --token-stdin ${quotedArgs}; }; status=$?; rm -f "$tmp"; exit $status`;
}

function psParam(name: string, value: string) {
  return `${name} ${psQuote(value)}`;
}

export function buildAgentInstallCommand({
  platform,
  serverUrl,
  options,
  instanceId,
  nodeName,
}: {
  platform: AgentInstallPlatform;
  serverUrl: string;
  options: AgentInstallOptions;
  instanceId?: string;
  nodeName?: string;
}) {
  const ghproxy = normalizeProxyUrl(options.ghproxy);
  const downloadProxy = normalizeProxyUrl(options.downloadProxy);
  const binaryUrl = options.binaryUrl?.trim();
  const binarySha256 = options.binarySha256?.trim();
  const checksumUrl = options.checksumUrl?.trim();
  const dir = options.dir.trim();
  const serviceName = options.serviceName.trim();
  const effectiveNodeName = nodeName?.trim();
  const effectiveInstanceId = instanceId?.trim() || effectiveNodeName || 'default';
  const mountInclude = options.mountInclude.trim();
  const mountExclude = options.mountExclude.trim();
  const nicInclude = options.nicInclude.trim();
  const nicExclude = options.nicExclude.trim();

  switch (platform) {
    case 'linux': {
      const args = ['--server', serverUrl];
      if (effectiveNodeName) args.push('--name', effectiveNodeName);
      if (!dir && !serviceName) args.push('--instance-id', effectiveInstanceId);
      if (binaryUrl) args.push('--binary-url', binaryUrl);
      if (binarySha256) args.push('--binary-sha256', binarySha256);
      if (checksumUrl) args.push('--checksum-url', checksumUrl);
      if (ghproxy) args.push('--install-ghproxy', ghproxy);
      if (downloadProxy) args.push('--proxy', downloadProxy);
      if (dir) args.push('--install-dir', dir);
      if (serviceName) args.push('--service-name', serviceName);
      if (mountInclude) args.push('--mount-include', mountInclude);
      if (mountExclude) args.push('--mount-exclude', mountExclude);
      if (nicInclude) args.push('--nic-include', nicInclude);
      if (nicExclude) args.push('--nic-exclude', nicExclude);
      return rootAwareBashInstall(cfMonitorAgentScriptUrl('install-linux.sh', ghproxy), 'wget', args);
    }
    case 'windows': {
      const args = [psParam('-Server', serverUrl)];
      if (effectiveNodeName) args.push(psParam('-Name', effectiveNodeName));
      if (!dir && !serviceName) args.push(psParam('-InstanceId', effectiveInstanceId));
      if (binaryUrl) args.push(psParam('-BinaryUrl', binaryUrl));
      if (binarySha256) args.push(psParam('-BinarySha256', binarySha256));
      if (checksumUrl) args.push(psParam('-ChecksumUrl', checksumUrl));
      if (ghproxy) args.push(psParam('-InstallGhproxy', ghproxy));
      if (downloadProxy) args.push(psParam('-Proxy', downloadProxy));
      if (dir) args.push(psParam('-InstallDir', dir));
      if (serviceName) args.push(psParam('-ServiceName', serviceName));
      if (mountInclude) args.push(psParam('-MountInclude', mountInclude));
      if (mountExclude) args.push(psParam('-MountExclude', mountExclude));
      if (nicInclude) args.push(psParam('-NicInclude', nicInclude));
      if (nicExclude) args.push(psParam('-NicExclude', nicExclude));
      return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
        '"`$token = Read-Host \'CF Monitor token\' -AsSecureString; ' +
        `iwr ${psQuote(cfMonitorAgentScriptUrl('install-windows.ps1', ghproxy))} -UseBasicParsing -OutFile 'install-windows.ps1'; ` +
        `& '.\\install-windows.ps1' -TokenSecure \`$token ${args.join(' ')}"`;
    }
    case 'macos': {
      const args = ['--server', serverUrl];
      if (effectiveNodeName) args.push('--name', effectiveNodeName);
      if (!dir && !serviceName) args.push('--instance-id', effectiveInstanceId);
      if (binaryUrl) args.push('--binary-url', binaryUrl);
      if (binarySha256) args.push('--binary-sha256', binarySha256);
      if (checksumUrl) args.push('--checksum-url', checksumUrl);
      if (ghproxy) args.push('--install-ghproxy', ghproxy);
      if (downloadProxy) args.push('--proxy', downloadProxy);
      if (dir) args.push('--install-dir', dir);
      if (serviceName) args.push('--service-name', serviceName);
      if (mountInclude) args.push('--mount-include', mountInclude);
      if (mountExclude) args.push('--mount-exclude', mountExclude);
      if (nicInclude) args.push('--nic-include', nicInclude);
      if (nicExclude) args.push('--nic-exclude', nicExclude);
      return rootAwareBashInstall(cfMonitorAgentScriptUrl('install-linux.sh', ghproxy), 'curl', args);
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
      return rootAwareBashPipe(
        `curl -fsSL ${shellQuote(cfMonitorAgentScriptUrl('install-linux.sh', proxy))}`,
        ['--uninstall-all', '--yes', ...(proxy ? ['--install-ghproxy', proxy] : [])],
      );
    case 'linux':
    default:
      return rootAwareBashPipe(
        `wget -qO- ${shellQuote(cfMonitorAgentScriptUrl('install-linux.sh', proxy))}`,
        ['--uninstall-all', '--yes', ...(proxy ? ['--install-ghproxy', proxy] : [])],
      );
  }
}
