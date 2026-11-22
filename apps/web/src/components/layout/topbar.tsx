'use client';

import { MenuIcon, XIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/common/theme-toggle';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SidebarContent } from './sidebar';
import { UserMenu } from './user-menu';

export function Topbar({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-md md:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          className="md:hidden"
          aria-label="Open navigation"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <MenuIcon />
        </Button>
        <div className="flex-1" />
        <ThemeToggle />
        <UserMenu />
      </header>

      {/* Mobile drawer */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity md:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-72 border-r bg-sidebar shadow-xl transition-transform duration-200 ease-out md:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
        <SidebarContent workspaceId={workspaceId} onNavigate={() => setOpen(false)} />
      </div>
    </>
  );
}
