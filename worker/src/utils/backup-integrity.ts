/**
 * 备份完整性校验工具
 *
 * 功能：
 * 1. HMAC签名生成
 * 2. HMAC签名验证
 * 3. 备份摘要生成
 */

/**
 * 生成备份的HMAC签名
 */
export async function generateBackupHMAC(
  backupData: any,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  // 排除hmac字段本身
  const { hmac, ...dataToSign } = backupData;
  const dataString = JSON.stringify(dataToSign, Object.keys(dataToSign).sort());
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(dataString),
  );

  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 验证备份的HMAC签名
 */
export async function verifyBackupHMAC(
  backupData: any,
  expectedHmac: string,
  secret: string,
): Promise<boolean> {
  try {
    const actualHmac = await generateBackupHMAC(backupData, secret);
    return actualHmac === expectedHmac;
  } catch (error) {
    console.error('[backup-hmac] Verification failed:', error);
    return false;
  }
}

/**
 * 生成备份摘要（用于确认界面）
 */
export function generateBackupSummary(backup: any): {
  version: string;
  timestamp: string;
  itemCount: {
    settings: number;
    clients: number;
    ping_tasks: number;
    notifications: number;
  };
  hasHmac: boolean;
  isEncrypted: boolean;
} {
  return {
    version: backup.version || 'unknown',
    timestamp: backup.timestamp || 'unknown',
    itemCount: {
      settings: Object.keys(backup.settings || {}).length,
      clients: (backup.clients || []).length,
      ping_tasks: (backup.ping_tasks || []).length,
      notifications:
        (backup.offline_notifications || []).length +
        (backup.expiry_notifications || []).length +
        (backup.load_notifications || []).length,
    },
    hasHmac: !!backup.hmac,
    isEncrypted: backup.encrypted === true,
  };
}

/**
 * 添加HMAC签名到备份
 */
export async function signBackup(
  backup: any,
  secret: string,
): Promise<any> {
  const hmac = await generateBackupHMAC(backup, secret);
  return {
    ...backup,
    hmac,
  };
}

/**
 * 验证并移除HMAC签名
 */
export async function verifyAndStripHMAC(
  backup: any,
  secret: string,
): Promise<{ valid: boolean; data: any; error?: string }> {
  if (!backup.hmac) {
    return {
      valid: false,
      data: backup,
      error: '备份文件缺少HMAC签名',
    };
  }

  const isValid = await verifyBackupHMAC(backup, backup.hmac, secret);

  if (!isValid) {
    return {
      valid: false,
      data: backup,
      error: 'HMAC签名验证失败，文件可能被篡改',
    };
  }

  // 移除hmac字段，返回原始数据
  const { hmac, ...data } = backup;

  return {
    valid: true,
    data,
  };
}

/**
 * 检查备份版本兼容性
 */
export function isBackupVersionCompatible(
  backupVersion: string,
  currentVersion: string,
): boolean {
  // 简单版本检查：主版本号必须匹配
  const backupMajor = backupVersion.split('.')[0];
  const currentMajor = currentVersion.split('.')[0];

  return backupMajor === currentMajor;
}
