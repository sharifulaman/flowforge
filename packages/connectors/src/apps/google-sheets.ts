import { AuthError, defineApp, FatalError, type HttpClient, objectSchema, RetryableError } from '@flowforge/connector-sdk';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Map Google API errors: 401 → reconnect, 429/5xx → retry, other 4xx → fail with Google's message. */
async function google<T>(http: HttpClient, token: string, url: string, init: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const res = await http.request<T & { error?: { message?: string; status?: string } }>({
    url,
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}` },
    body: init.body,
    query: init.query,
    throwOnError: false,
  });
  if (res.status < 400) return res.data;
  const message = res.data?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) throw new AuthError('Google rejected the access token — reconnect your Google account');
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`Google API: ${message}`, parseRetryAfter(res.headers['retry-after']));
  throw new FatalError(`Google API: ${message}`, `GOOGLE_${res.data?.error?.status ?? res.status}`);
}

const parseRetryAfter = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) * 1000 : undefined);

/** A1 notation needs quotes around sheet names with spaces/special characters. */
export const a1Sheet = (name: string) => `'${name.replace(/'/g, "''")}'`;

export default defineApp({
  key: 'google-sheets',
  name: 'Google Sheets',
  description: 'Add rows to Google Sheets spreadsheets.',
  category: 'productivity',
  icon: 'Sheet',
  color: '#0F9D58',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    // offline + consent → Google returns a refresh token.
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    test: async ({ auth, http }) => {
      const me = await google<{ email: string }>(http, auth.accessToken, 'https://openidconnect.googleapis.com/v1/userinfo');
      return { label: me.email, email: me.email };
    },
  },
  optionLoaders: {
    spreadsheets: async ({ auth, http }) => {
      const r = await google<{ files: Array<{ id: string; name: string }> }>(http, auth.accessToken, 'https://www.googleapis.com/drive/v3/files', {
        query: { q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false", orderBy: 'modifiedTime desc', pageSize: '200', fields: 'files(id,name)' },
      });
      return r.files.map((f) => ({ label: f.name, value: f.id }));
    },
    worksheets: async ({ auth, http, config }) => {
      if (!config.spreadsheetId || String(config.spreadsheetId).includes('{{')) return [];
      const r = await google<{ sheets: Array<{ properties: { title: string } }> }>(http, auth.accessToken, `${SHEETS}/${encodeURIComponent(String(config.spreadsheetId))}`, {
        query: { fields: 'sheets.properties.title' },
      });
      return r.sheets.map((s) => ({ label: s.properties.title, value: s.properties.title }));
    },
  },
  actions: [
    {
      key: 'addRow',
      name: 'Add row',
      description: 'Append a row to the bottom of a worksheet.',
      input: objectSchema(
        {
          spreadsheetId: { type: 'string', title: 'Spreadsheet', minLength: 1, 'x-ui': { dynamicOptions: 'spreadsheets' } },
          worksheet: { type: 'string', title: 'Worksheet', minLength: 1, default: 'Sheet1', 'x-ui': { dynamicOptions: 'worksheets', dependsOn: ['spreadsheetId'] } },
          values: {
            type: 'array',
            title: 'Cell values (columns A, B, C, …)',
            minItems: 1,
            maxItems: 200,
            items: { type: ['string', 'number', 'boolean', 'null'] },
          },
          valueInputOption: {
            type: 'string',
            title: 'Interpret values',
            enum: ['USER_ENTERED', 'RAW'],
            'x-enumLabels': ['As if typed (formulas, dates)', 'Raw text'],
            default: 'USER_ENTERED',
            'x-ui': { widget: 'select', advanced: true },
          },
        },
        ['spreadsheetId', 'worksheet', 'values'],
      ),
      sampleOutput: { spreadsheetId: '1AbC…', updatedRange: "'Sheet1'!A12:C12", updatedRows: 1, updatedCells: 3, rowNumber: 12 },
      async run({ input, auth, http }) {
        const range = encodeURIComponent(`${a1Sheet(input.worksheet)}!A1`);
        const r = await google<{ updates: { updatedRange: string; updatedRows: number; updatedCells: number } }>(
          http,
          auth.accessToken,
          `${SHEETS}/${encodeURIComponent(input.spreadsheetId)}/values/${range}:append`,
          {
            method: 'POST',
            query: { valueInputOption: input.valueInputOption ?? 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', includeValuesInResponse: 'false' },
            body: { majorDimension: 'ROWS', values: [(input.values as unknown[]).map((v) => (v === null ? '' : v))] },
          },
        );
        const row = /![A-Z]+(\d+)/.exec(r.updates.updatedRange)?.[1];
        return { spreadsheetId: input.spreadsheetId, ...r.updates, rowNumber: row ? Number(row) : null };
      },
    },
  ],
});
