'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '', label: 'General' },
  { href: '/members', label: 'Members' },
  { href: '/api-keys', label: 'API keys' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();
  const base = `/w/${workspaceId}/settings`;
  return (
    <>
      <PageHeader title="Settings" description="Manage this workspace, its members and API access." />
      <nav className="mb-6 flex gap-1 border-b" aria-label="Settings">
        {TABS.map((t) => {
          const href = `${base}${t.href}`;
          const active = pathname === href;
          return (
            <Link
              key={t.label}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors', active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div className="max-w-3xl">{children}</div>
    </>
  );
}
