import {
  ActivityIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  PlugIcon,
  SettingsIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  /** Path relative to /w/[workspaceId]. */
  href: string;
  icon: LucideIcon;
  /** Not yet available; rendered disabled with a "Soon" badge. */
  soon?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '', icon: LayoutDashboardIcon },
  { label: 'Zaps', href: '/zaps', icon: WorkflowIcon, soon: true },
  { label: 'Runs', href: '/runs', icon: ActivityIcon, soon: true },
  { label: 'Connections', href: '/connections', icon: PlugIcon, soon: true },
];

export const NAV_SECONDARY: NavItem[] = [
  { label: 'API keys', href: '/settings/api-keys', icon: KeyRoundIcon, soon: true },
  { label: 'Settings', href: '/settings', icon: SettingsIcon, soon: true },
];
