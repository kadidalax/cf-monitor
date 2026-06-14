/**
 * Reusable SettingCard components matching Komari's admin pattern
 * Provides collapsible sections with consistent styling
 */
import React, { useState } from 'react';
import { Card, Flex, Text, Switch, TextField, TextArea } from '@radix-ui/themes';
import { ChevronDown, ChevronRight } from 'lucide-react';

/* ========== Collapsible SettingCard ========== */
interface SettingCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export function SettingCard({ title, description, children, defaultOpen = true }: SettingCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card style={{ marginBottom: 12 }}>
      <Flex asChild align="center" justify="between">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          style={{
            width: '100%',
            border: 0,
            margin: 0,
            padding: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <Flex direction="column">
            <Text size="3" weight="bold">{title}</Text>
            {description && <Text size="1" color="gray">{description}</Text>}
          </Flex>
          <span
            aria-hidden="true"
            style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--gray-11)' }}
          >
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </button>
      </Flex>
      {open && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gray-4)' }}>
          {children}
        </div>
      )}
    </Card>
  );
}

/* ========== Setting Row ========== */
interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <Flex justify="between" align="center" style={{ padding: '8px 0' }}>
      <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
        <Text size="2" weight="medium">{label}</Text>
        {description && <Text size="1" color="gray">{description}</Text>}
      </Flex>
      <div style={{ flexShrink: 0, marginLeft: 16 }}>{children}</div>
    </Flex>
  );
}

/* ========== Setting Toggle ========== */
interface SettingToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SettingToggle({ label, description, checked, onCheckedChange }: SettingToggleProps) {
  return (
    <SettingRow label={label} description={description}>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </SettingRow>
  );
}

/* ========== Setting Input ========== */
interface SettingInputProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  width?: number | string;
}

export function SettingInput({ label, description, value, onChange, type, placeholder, width }: SettingInputProps) {
  const inputWidth = width || (type === 'number' ? 180 : type === 'password' ? 360 : 420);

  return (
    <div style={{ marginBottom: 12 }}>
      <Text size="2" weight="medium" style={{ display: 'block', marginBottom: 4 }}>{label}</Text>
      {description && <Text size="1" color="gray" style={{ display: 'block', marginBottom: 6 }}>{description}</Text>}
      <TextField.Root
        size="2"
        style={{ width: inputWidth, maxWidth: '100%' }}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        type={(type || 'text') as any}
        placeholder={placeholder}
      />
    </div>
  );
}
