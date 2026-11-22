'use client';

import { ActivityIcon, ArrowRightIcon, PlugIcon, WorkflowIcon } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMe } from '@/hooks/use-auth';

const STEPS = [
  {
    icon: PlugIcon,
    href: '/connections',
    title: 'Connect an app',
    description: 'Securely add credentials for Slack, Google Sheets, Telegram, SMTP and more.',
  },
  {
    icon: WorkflowIcon,
    href: '/zaps',
    title: 'Build your first Zap',
    description: 'Pick a trigger, add actions, and map data between steps visually.',
  },
  {
    icon: ActivityIcon,
    href: '/zaps',
    title: 'Watch it run',
    description: 'Inspect every run step-by-step, and replay failures with one click.',
  },
];

export default function DashboardPage() {
  const { data } = useMe();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const firstName = data?.user.name?.split(' ')[0];

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome, ${firstName}` : 'Welcome'}
        description="Here's how to get your first automation running."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <Link key={s.title} href={`/w/${workspaceId}${s.href}`} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none">
          <Card className="group relative h-full gap-4 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
            <CardHeader className="gap-3">
              <div className="flex items-center justify-between">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-4" />
                </span>
                <Badge variant="secondary">Step {i + 1}</Badge>
              </div>
              <CardTitle className="flex items-center gap-1.5">
                {s.title}
                <ArrowRightIcon className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-60" />
              </CardTitle>
              <CardDescription>{s.description}</CardDescription>
            </CardHeader>
          </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
