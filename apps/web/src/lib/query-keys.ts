export const queryKeys = {
  me: ['me'] as const,
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspaces', id] as const,
  apps: ['apps'] as const,
  zaps: (ws: string) => ['zaps', ws] as const,
  zapList: (ws: string, filters: object) => ['zaps', ws, 'list', filters] as const,
  zap: (ws: string, zapId: string) => ['zaps', ws, 'detail', zapId] as const,
  samples: (ws: string, zapId: string) => ['zaps', ws, 'samples', zapId] as const,
  versions: (ws: string, zapId: string) => ['zaps', ws, 'versions', zapId] as const,
  connections: (ws: string) => ['connections', ws] as const,
  options: (ws: string, appKey: string, loader: string, connectionId: string | null, deps: string) =>
    ['options', ws, appKey, loader, connectionId, deps] as const,
};
