'use client';

import { SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/common/empty-state';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/hooks/use-auth';

export function WorkspaceShell({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  const { data, isLoading } = useMe();
  const member = data?.workspaces.some((w) => w.id === workspaceId);

  return (
    <div className="flex min-h-dvh">
      <Sidebar workspaceId={workspaceId} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar workspaceId={workspaceId} />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8">
          {isLoading ? (
            <div className="grid gap-4">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-4 w-80" />
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
                <Skeleton className="h-28" />
              </div>
            </div>
          ) : data && !member ? (
            <EmptyState
              icon={SearchXIcon}
              title="Workspace not found"
              description="It may have been deleted, or you don't have access to it."
              action={
                <Button asChild variant="outline">
                  <Link href="/">Go to my workspace</Link>
                </Button>
              }
            />
          ) : (
            <div className="animate-in fade-in-0 duration-300">{children}</div>
          )}
        </main>
      </div>
    </div>
  );
}
