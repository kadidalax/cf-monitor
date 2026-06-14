/**
 * 前端输入验证和XSS防护
 *
 * 功能：
 * 1. 字段长度限制
 * 2. 字符白名单验证
 * 3. HTML标签过滤
 * 4. URL安全检查
 */

/**
 * 字段长度限制
 */
export const FIELD_LIMITS = {
  name: 100,
  remark: 500,
  public_remark: 200,
  tags: 200,
  group: 50,
  region: 100,
  ipv4: 45,
  ipv6: 45,
  telegram_chat_id: 50,
  url: 2048,
} as const;

/**
 * 验证字符串长度
 */
export function validateLength(
  value: string,
  field: keyof typeof FIELD_LIMITS,
): { valid: boolean; error?: string } {
  const limit = FIELD_LIMITS[field];

  if (!value) {
    return { valid: true };
  }

  if (value.length > limit) {
    return {
      valid: false,
      error: `${field}长度不能超过${limit}个字符`,
    };
  }

  return { valid: true };
}

/**
 * 清理HTML标签（防止XSS）
 */
export function sanitizeHtml(input: string): string {
  if (!input) return '';

  // 移除所有HTML标签
  return input
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .trim();
}

/**
 * 验证安全的显示名称
 */
export function validateDisplayName(name: string): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  if (!name) {
    return { valid: false, sanitized: '', error: '名称不能为空' };
  }

  const sanitized = sanitizeHtml(name);

  const lengthCheck = validateLength(sanitized, 'name');
  if (!lengthCheck.valid) {
    return { valid: false, sanitized, error: lengthCheck.error };
  }

  // 检查是否包含控制字符
  if (/[\x00-\x1F\x7F]/.test(sanitized)) {
    return {
      valid: false,
      sanitized,
      error: '名称包含非法字符',
    };
  }

  return { valid: true, sanitized };
}

/**
 * 验证备注字段
 */
export function validateRemark(remark: string, isPublic = false): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  if (!remark) {
    return { valid: true, sanitized: '' };
  }

  const sanitized = sanitizeHtml(remark);

  const field = isPublic ? 'public_remark' : 'remark';
  const lengthCheck = validateLength(sanitized, field);

  if (!lengthCheck.valid) {
    return { valid: false, sanitized, error: lengthCheck.error };
  }

  return { valid: true, sanitized };
}

/**
 * 验证URL安全性
 */
export function validateSafeUrl(url: string): {
  valid: boolean;
  error?: string;
} {
  if (!url) {
    return { valid: true };
  }

  // 检查长度
  const lengthCheck = validateLength(url, 'url');
  if (!lengthCheck.valid) {
    return lengthCheck;
  }

  // 只允许http、https、data协议
  const allowedProtocols = ['http:', 'https:', 'data:'];

  try {
    const parsed = new URL(url);

    if (!allowedProtocols.includes(parsed.protocol)) {
      return {
        valid: false,
        error: `不支持的协议: ${parsed.protocol}`,
      };
    }

    // 检查data URL
    if (parsed.protocol === 'data:') {
      // 只允许图片
      if (!url.startsWith('data:image/')) {
        return {
          valid: false,
          error: 'Data URL只支持图片类型',
        };
      }

      // 检查大小（限制2MB）
      if (url.length > 2 * 1024 * 1024) {
        return {
          valid: false,
          error: 'Data URL大小不能超过2MB',
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: '无效的URL格式' };
  }
}

/**
 * 验证标签列表
 */
export function validateTags(tags: string): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  if (!tags) {
    return { valid: true, sanitized: '' };
  }

  const sanitized = sanitizeHtml(tags);

  const lengthCheck = validateLength(sanitized, 'tags');
  if (!lengthCheck.valid) {
    return { valid: false, sanitized, error: lengthCheck.error };
  }

  // 标签只允许字母、数字、中文、下划线、连字符、空格
  const validPattern = /^[\w一-龥\s\-,]+$/;
  if (!validPattern.test(sanitized)) {
    return {
      valid: false,
      sanitized,
      error: '标签只能包含字母、数字、中文、下划线、连字符',
    };
  }

  return { valid: true, sanitized };
}

/**
 * 验证分组名称
 */
export function validateGroup(group: string): {
  valid: boolean;
  sanitized: string;
  error?: string;
} {
  if (!group) {
    return { valid: true, sanitized: '' };
  }

  const sanitized = sanitizeHtml(group);

  const lengthCheck = validateLength(sanitized, 'group');
  if (!lengthCheck.valid) {
    return { valid: false, sanitized, error: lengthCheck.error };
  }

  return { valid: true, sanitized };
}

/**
 * 验证IP地址
 */
export function validateIpAddress(ip: string, version: 4 | 6 = 4): {
  valid: boolean;
  error?: string;
} {
  if (!ip) {
    return { valid: true };
  }

  if (version === 4) {
    // IPv4: xxx.xxx.xxx.xxx
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Pattern.test(ip)) {
      return { valid: false, error: '无效的IPv4地址' };
    }

    const parts = ip.split('.');
    for (const part of parts) {
      const num = parseInt(part, 10);
      if (num < 0 || num > 255) {
        return { valid: false, error: 'IPv4地址每段必须在0-255之间' };
      }
    }
  } else {
    // IPv6: 简化验证
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    if (!ipv6Pattern.test(ip)) {
      return { valid: false, error: '无效的IPv6地址' };
    }
  }

  return { valid: true };
}

/**
 * 批量验证表单数据
 */
export function validateFormData(data: {
  name?: string;
  remark?: string;
  public_remark?: string;
  tags?: string;
  group?: string;
  ipv4?: string;
  ipv6?: string;
}): {
  valid: boolean;
  errors: Record<string, string>;
  sanitized: typeof data;
} {
  const errors: Record<string, string> = {};
  const sanitized: any = {};

  if (data.name !== undefined) {
    const result = validateDisplayName(data.name);
    if (!result.valid) {
      errors.name = result.error || '名称无效';
    }
    sanitized.name = result.sanitized;
  }

  if (data.remark !== undefined) {
    const result = validateRemark(data.remark, false);
    if (!result.valid) {
      errors.remark = result.error || '备注无效';
    }
    sanitized.remark = result.sanitized;
  }

  if (data.public_remark !== undefined) {
    const result = validateRemark(data.public_remark, true);
    if (!result.valid) {
      errors.public_remark = result.error || '公开备注无效';
    }
    sanitized.public_remark = result.sanitized;
  }

  if (data.tags !== undefined) {
    const result = validateTags(data.tags);
    if (!result.valid) {
      errors.tags = result.error || '标签无效';
    }
    sanitized.tags = result.sanitized;
  }

  if (data.group !== undefined) {
    const result = validateGroup(data.group);
    if (!result.valid) {
      errors.group = result.error || '分组无效';
    }
    sanitized.group = result.sanitized;
  }

  if (data.ipv4 !== undefined) {
    const result = validateIpAddress(data.ipv4, 4);
    if (!result.valid) {
      errors.ipv4 = result.error || 'IPv4地址无效';
    }
    sanitized.ipv4 = data.ipv4;
  }

  if (data.ipv6 !== undefined) {
    const result = validateIpAddress(data.ipv6, 6);
    if (!result.valid) {
      errors.ipv6 = result.error || 'IPv6地址无效';
    }
    sanitized.ipv6 = data.ipv6;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    sanitized,
  };
}

/**
 * React Hook: 表单验证
 */
export function useFormValidation<T extends Record<string, any>>(
  initialValues: T,
  validator: (values: T) => { valid: boolean; errors: Record<string, string> },
) {
  const [values, setValues] = React.useState<T>(initialValues);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});

  const handleChange = (field: keyof T, value: any) => {
    setValues(prev => ({ ...prev, [field]: value }));

    // 如果字段已被触摸，立即验证
    if (touched[field as string]) {
      const result = validator({ ...values, [field]: value });
      setErrors(result.errors);
    }
  };

  const handleBlur = (field: keyof T) => {
    setTouched(prev => ({ ...prev, [field as string]: true }));

    // 触摸后验证
    const result = validator(values);
    setErrors(result.errors);
  };

  const handleSubmit = (onSubmit: (values: T) => void) => {
    return (e: React.FormEvent) => {
      e.preventDefault();

      const result = validator(values);
      setErrors(result.errors);

      // 标记所有字段为已触摸
      const allTouched = Object.keys(values).reduce(
        (acc, key) => ({ ...acc, [key]: true }),
        {},
      );
      setTouched(allTouched);

      if (result.valid) {
        onSubmit(values);
      }
    };
  };

  return {
    values,
    errors,
    touched,
    handleChange,
    handleBlur,
    handleSubmit,
  };
}

// 导出React用于hook
import * as React from 'react';
