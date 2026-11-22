'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Logo } from '@/components/common/logo';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, NAV_SECONDARY, type NavItem } from './nav-config';
import { WorkspaceSwitcher } from './workspace-switcher';

function NavLink({ item, base, onNavigate }: { item: NavItem; base: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const href = `${base}${item.href}`;
  const active = item.href === '' ? pathname === base : item.exact ? item.exact.some((p) => pathname === `${base}${p}`) : pathname.startsWith(href);
  const Icon = item.icon;

  const classes = cn(
    'group flex h-9 items-center gap-3 rounded-md px-2.5 text-sm font-medium transition-colors',
    active
      ? 'bg-sidebar-accent text-foreground shadow-xs'
      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
    item.soon && 'pointer-events-none opacity-60',
  );

  const content = (
    <>
      <Icon className={cn('size-4 transition-colors', active && 'text-primary')} />
      <span className="flex-1">{item.label}</span>
      {item.soon && (
        <Badge variant="secondary" className="px-1.5 text-[10px]">
          Soon
        </Badge>
      )}
    </>
  );

  if (item.soon) {
    return (
      <span aria-disabled className={classes}>
        {content}
      </span>
    );
  }
  return (
    <Link href={href} className={classes} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
      {content}
    </Link>
  );
}

export function SidebarContent({ workspaceId, onNavigate }: { workspaceId: string; onNavigate?: () => void }) {
  const base = `/w/${workspaceId}`;
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-1.5 pt-1">
        <Logo />
      </div>
      <WorkspaceSwitcher workspaceId={workspaceId} />
      <nav className="grid gap-0.5" aria-label="Main">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.label} item={item} base={base} onNavigate={onNavigate} />
        ))}
      </nav>
      <nav className="mt-auto grid gap-0.5" aria-label="Workspace settings">
        <p className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Workspace</p>
        {NAV_SECONDARY.map((item) => (
          <NavLink key={item.label} item={item} base={base} onNavigate={onNavigate} />
        ))}
      </nav>
    </div>
  );
}

export function Sidebar({ workspaceId }: { workspaceId: string }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r bg-sidebar md:block">
      <SidebarContent workspaceId={workspaceId} />
    </aside>
  );
}
