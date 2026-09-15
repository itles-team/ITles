export type Status = 'fresh' | 'stale' | 'missing' | 'invalid'

export interface Metric {
  key: string
  label: string
  value: number | null
  unit: string
  observed_at: string | null
  status: Status
  source: string | null
  explanation: string | null
  norm: string | null
}

export interface Position {
  latitude: number
  longitude: number
  observed_at: string
  status: Status
}

export interface Machine {
  id: string
  name: string
  model: string | null
  head: string | null
  computer: string | null
  connection_status: Status
  metrics: Metric[]
  position: Position | null
  last_seen: string | null
}

export interface VolumeTotal { basis: string; volume_m3: string; records: number }
export interface FleetData {
  period: { start: string; end: string }
  totals: VolumeTotal[]
  machines: { id: string; name: string; totals: VolumeTotal[]; engine_hours: number | null }[]
  record_count: number
}
export interface MachineDetail extends Machine {
  production: { event_id: string; occurred_at: string; volume_m3: string; basis: string; source: string; method: string }[]
  totals: VolumeTotal[]
  track: { latitude: number; longitude: number; observed_at: string }[]
  engine_hours: number | null
}
export interface Quality {
  counts: { accepted: number; duplicates: number; rejected: number }
  recent: { received_at: string; status: Status; reason: string | null; machine_id: string | null }[]
  limitations: string[]
}
export interface Session { organization: { id: string; name: string }; demo: boolean }
export interface Document { name: string; title: string; url: string; format: string }

export class ApiError extends Error {
  constructor(message: string, public status?: number) { super(message) }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  } catch {
    throw new ApiError('Сервер недоступен. Проверьте соединение и повторите попытку.')
  }
  if (!response.ok) {
    let message = 'Не удалось получить данные.'
    try {
      const payload: unknown = await response.json()
      if (typeof payload === 'object' && payload !== null && 'detail' in payload && typeof payload.detail === 'string') message = payload.detail
    } catch { /* response has no JSON */ }
    throw new ApiError(message, response.status)
  }
  try {
    return await response.json() as T
  } catch {
    throw new ApiError('Сервер вернул ответ в неожиданном формате. Повторите запрос или обратитесь к администратору.')
  }
}

export const api = {
  me: () => request<Session>('/api/auth/me'),
  login: (account: string, password: string) => request<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) }),
  demo: () => request<Session>('/api/auth/demo', { method: 'POST' }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  machines: () => request<{ machines: Machine[]; demo: boolean }>('/api/machines'),
  fleet: (start: string, end: string) => request<FleetData>(`/api/fleet?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  machine: (id: string, start: string, end: string) => request<MachineDetail>(`/api/machines/${encodeURIComponent(id)}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  quality: () => request<Quality>('/api/quality'),
  documents: () => request<{ documents: Document[] }>('/api/documents'),
}
