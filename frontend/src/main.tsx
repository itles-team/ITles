import React, { FormEvent, useEffect, useId, useRef, useState } from 'react'
import { createPortal, createRoot } from 'react-dom/client'
import { CircleMarker, GeoJSON, MapContainer, Polyline, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import type { GeoJsonObject } from 'geojson'
import {
  AlertTriangle, BarChart3, BookOpen, CalendarDays, ChevronRight, CircleHelp,
  Database, Download, FileText, LogOut, Map as MapIcon, Menu, RefreshCw,
  Route, ShieldCheck, Trees, X,
} from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import naturalEarthRussiaRegion from './assets/natural-earth-russia-region.geojson'

type Status = 'fresh' | 'stale' | 'missing' | 'invalid'
type Metric = { key: string; label: string; value: number | null; unit: string; observed_at: string | null; status: Status; source: string; explanation: string; norm: string | null }
type Position = { latitude: number; longitude: number; observed_at: string; status: Status }
type Machine = { id: string; name: string; model: string | null; head: string | null; computer: string | null; connection_status: Status; metrics: Metric[]; position: Position | null; last_seen: string | null }
type Provenance = { sources: string[]; methods: string[]; method_versions: string[]; calibration_refs: string[] }
type Total = { basis: 'under_bark' | 'over_bark' | 'unknown'; volume_m3: string; records: number; provenance?: Provenance; warnings?: string[] }
type Fleet = { period: { start: string; end: string }; totals: Total[]; machines: { id: string; name: string; totals: Total[]; engine_hours: number | null }[]; record_count: number }
type MachineDetail = Machine & { production: { event_id: string; occurred_at: string; volume_m3: string; basis: string; source: string; method: string; method_version: string; calibration_ref: string | null }[]; totals: Total[]; track: { latitude: number; longitude: number; observed_at: string }[]; engine_hours: number | null }
type Quality = { counts: { accepted: number; duplicates: number; rejected: number }; recent: { received_at: string; status: string; reason: string | null; machine_id: string | null }[]; limitations: string[] }
type DocumentItem = { name: string; title: string; url: string; format: string }
type Session = { organization: { id: string; name: string }; demo: boolean }

const today = new Date().toISOString().slice(0, 10)
const nav = [
  ['map', 'Карта производства', MapIcon], ['fleet', 'Парк и объём', BarChart3],
  ['quality', 'Качество данных', ShieldCheck], ['data', 'Передача данных', Database], ['docs', 'Исследования', BookOpen],
] as const

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `Ошибка запроса (${response.status})`)
  }
  return response.json() as Promise<T>
}

function displayDate(value: string | null) {
  if (!value) return 'нет данных'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
}
function observationAge(value: string | null) {
  if (!value) return 'не поступало'
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000))
  return hours < 1 ? 'наблюдалось менее часа назад' : hours < 24 ? `наблюдалось ${hours} ч назад` : `наблюдалось ${Math.floor(hours / 24)} дн. назад`
}
function basisName(basis: string) { return basis === 'under_bark' ? 'без коры' : basis === 'over_bark' ? 'с корой' : 'база не указана' }
function statusLabel(status: Status) { return ({ fresh: 'актуальные', stale: 'устарели', missing: 'нет данных', invalid: 'ошибка данных' } as Record<Status, string>)[status] }
function metricValue(metric: Metric) { return metric.value === null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(metric.value) }
function volume(value: string) {
  const [integer, fraction = ''] = value.split('.')
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  const significantFraction = fraction.slice(0, 6).replace(/0+$/, '')
  return significantFraction ? `${grouped},${significantFraction}` : grouped
}

function StatusPill({ status }: { status: Status }) { return <span className={`status status--${status}`}><i />{statusLabel(status)}</span> }
function Explanation({ label, text, norm }: { label: string; text: string; norm: string | null }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const headingId = useId()
  useEffect(() => {
    if (!open) return
    const opener = trigger.current
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button,[href],[tabindex]:not([tabindex="-1"])') ?? [])
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
      if (event.key === 'Tab') {
        const controls = focusable()
        if (!controls.length) return
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', close)
    dialog.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { window.removeEventListener('keydown', close); opener?.focus() }
  }, [open])
  return <><button ref={trigger} type="button" className="explanation" aria-label={`${label}: открыть пояснение`} aria-expanded={open} aria-haspopup="dialog" aria-controls={headingId} onClick={() => setOpen(true)}><CircleHelp size={15} /></button>{open && createPortal(<div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}><div className="metric-modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={headingId}><div><p className="eyebrow">ПОЯСНЕНИЕ ПОКАЗАТЕЛЯ</p><h2 id={headingId}>{label}</h2></div><button type="button" className="modal-close" aria-label="Закрыть пояснение" onClick={() => setOpen(false)}><X size={18} /></button><p>{text}</p><p className="modal-norm">{norm ? `Норма: ${norm}` : 'Норма не подтверждена для этой машины и узла.'}</p></div></div>, document.body)}</>
}
function Empty({ children }: { children: React.ReactNode }) { return <div className="empty"><Database size={22} /><p>{children}</p></div> }

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function login(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true)
    try { onSession(await request<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) })) }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось войти') } finally { setBusy(false) }
  }
  async function demo() {
    setError(''); setBusy(true)
    try { onSession(await request<Session>('/api/auth/demo', { method: 'POST' })) }
    catch (err) { setError(err instanceof Error ? err.message : 'Учебный парк недоступен') } finally { setBusy(false) }
  }
  return <main className="login-shell"><section className="login-brand"><div className="brand-mark"><Trees size={27} /></div><p className="eyebrow">ПРОИЗВОДСТВЕННАЯ ТЕЛЕМЕТРИЯ</p><h1>ИТлес</h1><p>Карта, журнал и происхождение данных — без подмены измерений прогнозами.</p><div className="login-note"><ShieldCheck size={18} />Вход по коду организации. Интерфейс не запрашивает имена или e-mail; код и пароль — учётные данные.</div></section><section className="login-card" aria-labelledby="login-title"><p className="eyebrow">ЗАЩИЩЁННЫЙ ДОСТУП</p><h2 id="login-title">Открыть свой парк</h2><form onSubmit={login}><label>Код организации<input autoComplete="username" required minLength={2} value={account} onChange={e => setAccount(e.target.value)} placeholder="Например: les-001" /></label><label>Пароль<input autoComplete="current-password" required minLength={12} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Не менее 12 символов" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--primary" disabled={busy}>{busy ? 'Проверяем…' : 'Войти в организацию'}<ChevronRight size={18} /></button></form><div className="login-divider"><span>или</span></div><button className="button button--secondary" disabled={busy} onClick={demo}>Открыть учебный парк <ChevronRight size={18} /></button><p className="fine-print">Учебный парк содержит демонстрационные записи и не подтверждает подключение к технике.</p></section></main>
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [checked, setChecked] = useState(false)
  useEffect(() => { request<Session>('/api/auth/me').then(setSession).catch(() => null).finally(() => setChecked(true)) }, [])
  if (!checked) return <div className="splash"><Trees size={26} />Загрузка ИТлес</div>
  return session ? <Workspace session={session} onLogout={() => setSession(null)} /> : <Login onSession={setSession} />
}

function Workspace({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [view, setView] = useState<(typeof nav)[number][0]>('map')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [dates, setDates] = useState({ start: today, end: today })
  const [machines, setMachines] = useState<Machine[]>([])
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [detail, setDetail] = useState<MachineDetail | null>(null)
  const [quality, setQuality] = useState<Quality | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const validDates = dates.start <= dates.end
  const query = `start=${encodeURIComponent(dates.start)}&end=${encodeURIComponent(dates.end)}`
  const load = async (manual = false) => {
    if (!validDates) return
    setError(''); manual ? setRefreshing(true) : setLoading(true)
    try {
      const [machinePayload, fleetPayload] = await Promise.all([request<{ machines: Machine[] }>('/api/machines'), request<Fleet>(`/api/fleet?${query}`)])
      setMachines(machinePayload.machines); setFleet(fleetPayload)
      const id = selected && machinePayload.machines.some(m => m.id === selected) ? selected : machinePayload.machines[0]?.id ?? null
      setSelected(id)
    } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось получить данные') } finally { setLoading(false); setRefreshing(false) }
  }
  useEffect(() => { void load() }, [dates.start, dates.end])
  useEffect(() => { if (!selected || !validDates) { setDetail(null); return }; request<MachineDetail>(`/api/machines/${encodeURIComponent(selected)}?${query}`).then(setDetail).catch(err => setError(err instanceof Error ? err.message : 'Не удалось открыть машину')) }, [selected, query])
  useEffect(() => { if (view === 'quality') request<Quality>('/api/quality').then(setQuality).catch(err => setError(err instanceof Error ? err.message : 'Не удалось загрузить журнал')) }, [view])
  function select(id: string) { setSelected(id); setOpen(false); setView('map') }
  async function logout() { await request('/api/auth/logout', { method: 'POST' }).catch(() => null); onLogout() }
  return <div className="app-shell">
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`} aria-label="Основная навигация"><div className="sidebar-head"><div className="wordmark"><Trees size={21} />ИТлес</div><button className="icon-button close-nav" aria-label="Закрыть меню" onClick={() => setOpen(false)}><X /></button></div><div className="org-name">{session.organization.name}</div><nav>{nav.map(([id, label, Icon]) => <button key={id} className={view === id ? 'nav-item nav-item--active' : 'nav-item'} onClick={() => { setView(id); setOpen(false) }}><Icon size={18} />{label}</button>)}</nav><div className="sidebar-foot"><div className="privacy"><ShieldCheck size={16} />Персональные данные не отображаются</div><button className="logout" onClick={logout}><LogOut size={16} />Выйти</button></div></aside>
    {open && <button className="backdrop" aria-label="Закрыть меню" onClick={() => setOpen(false)} />}
    <main className="workspace"><header className="topbar"><button className="icon-button menu-button" aria-label="Открыть меню" onClick={() => setOpen(true)}><Menu /></button><div><p className="eyebrow">{view === 'map' ? 'ОПЕРАЦИОННАЯ КАРТА' : 'ИТЛЕС / ' + nav.find(x => x[0] === view)?.[1].toUpperCase()}</p><h1>{view === 'map' ? 'Производственная карта' : nav.find(x => x[0] === view)?.[1]}</h1></div><div className="date-controls"><CalendarDays size={17} /><label>с<input type="date" value={dates.start} max={dates.end} onChange={e => setDates(x => ({ ...x, start: e.target.value }))} /></label><label>по<input type="date" value={dates.end} min={dates.start} onChange={e => setDates(x => ({ ...x, end: e.target.value }))} /></label></div><button className="refresh" onClick={() => void load(true)} disabled={refreshing || !validDates}><RefreshCw size={17} className={refreshing ? 'spin' : ''} />Обновить</button></header>
      {session.demo && <div className="demo-ribbon"><AlertTriangle size={16} /><b>Учебный парк</b><span>Записи созданы для проверки интерфейса. Они не являются данными с подключённой техники.</span></div>}
      {!validDates && <div className="message message--error" role="alert">Дата окончания не может быть раньше даты начала.</div>}
      {error && <div className="message message--error" role="alert"><AlertTriangle size={17} />{error}<button onClick={() => setError('')} aria-label="Закрыть сообщение"><X size={16} /></button></div>}
      {loading ? <div className="loading">Получаем журнал и состояние машин…</div> : <View view={view} machines={machines} fleet={fleet} detail={detail} quality={quality} selected={selected} onSelect={select} dates={dates} />}
    </main>
  </div>
}

function View({ view, ...props }: { view: string; machines: Machine[]; fleet: Fleet | null; detail: MachineDetail | null; quality: Quality | null; selected: string | null; onSelect: (id: string) => void; dates: { start: string; end: string } }) {
  if (view === 'fleet') return <FleetView {...props} />
  if (view === 'quality') return <QualityView quality={props.quality} />
  if (view === 'data') return <DataView dates={props.dates} />
  if (view === 'docs') return <Documents />
  return <MapView {...props} />
}

function MapView({ machines, detail, selected, onSelect }: Omit<Parameters<typeof View>[0], 'view' | 'fleet' | 'quality' | 'dates'>) {
  const positioned = machines.filter(m => m.position)
  const center: L.LatLngTuple = positioned.length ? [positioned.reduce((sum, m) => sum + m.position!.latitude, 0) / positioned.length, positioned.reduce((sum, m) => sum + m.position!.longitude, 0) / positioned.length] : [61.5, 90]
  return <div className="map-layout"><section className="map-stage" aria-label="Карта последних известных позиций"><MapContainer center={center} zoom={5} scrollWheelZoom className="offline-map" zoomControl={false} attributionControl={false}><GeoJSON data={naturalEarthRussiaRegion as GeoJsonObject} style={{ color: '#75988b', weight: 1, fillColor: '#cfddcc', fillOpacity: 0.72 }} /><div className="map-label map-label--north">РОССИЯ И СОПРЕДЕЛЬНЫЕ ТЕРРИТОРИИ</div><div className="map-grid-note">Карта работает без внешних тайлов. Показаны только координаты, принятые системой.</div>{detail?.track && detail.track.length > 1 && <Polyline positions={detail.track.map(p => [p.latitude, p.longitude])} pathOptions={{ color: '#78a99d', weight: 2, dashArray: '5 7' }} />}{positioned.map(machine => <CircleMarker key={machine.id} center={[machine.position!.latitude, machine.position!.longitude]} radius={machine.id === selected ? 10 : 7} pathOptions={{ color: '#12342f', fillColor: machine.id === selected ? '#eeac4a' : '#2e8170', fillOpacity: 1, weight: 3 }} eventHandlers={{ click: () => onSelect(machine.id) }}><Tooltip direction="top" opacity={1}>{machine.name}<br /><small>{statusLabel(machine.position!.status)} · {observationAge(machine.position!.observed_at)}</small></Tooltip></CircleMarker>)}</MapContainer><div className="map-legend"><span><i className="legend-dot" />последняя известная позиция</span><span><Route size={14} />линия — полученные точки периода</span></div><div className="map-attribution">Границы: Natural Earth, Admin 0 Countries 1:110m · public domain</div></section><aside className="machine-panel"><div className="panel-heading"><div><p className="eyebrow">ТЕХНИКА</p><h2>{machines.length} ед.</h2></div><span>Выберите на карте</span></div><div className="machine-list">{machines.length === 0 ? <Empty>Нет машин, доступных этой организации.</Empty> : machines.map(machine => <button key={machine.id} className={`machine-row ${machine.id === selected ? 'machine-row--selected' : ''}`} onClick={() => onSelect(machine.id)}><span className={`signal signal--${machine.connection_status}`} /><span><b>{machine.name}</b><small>{machine.model || 'модель не указана'}</small></span><ChevronRight size={17} /></button>)}</div>{detail ? <MachineDetails detail={detail} /> : <Empty>Выберите машину, чтобы открыть карточку.</Empty>}</aside></div>
}
function MachineDetails({ detail }: { detail: MachineDetail }) { return <section className="detail"><div className="detail-title"><div><p className="eyebrow">КАРТОЧКА МАШИНЫ</p><h2>{detail.name}</h2></div><StatusPill status={detail.connection_status} /></div><p className="machine-spec">{[detail.model, detail.head, detail.computer].filter(Boolean).join(' · ') || 'Конфигурация не поступала'}</p><div className="position-reading"><MapIcon size={16} /><span><b>Последняя известная позиция</b>{detail.position ? `${displayDate(detail.position.observed_at)} · ${observationAge(detail.position.observed_at)}` : 'координаты не поступали'}</span></div><div className="metrics">{detail.metrics.map(metric => <div className="metric" key={metric.key}><div><span>{metric.label}</span><Explanation label={metric.label} text={metric.explanation} norm={metric.norm} /></div><strong>{metricValue(metric)}<em>{metric.value !== null ? metric.unit : ''}</em></strong><footer><StatusPill status={metric.status} /><small>{metric.observed_at ? `наблюдение: ${displayDate(metric.observed_at)}` : 'не поступал'}</small></footer>{!metric.norm && <p className="norm-note">Норма не подтверждена</p>}</div>)}</div><div className="volume-box"><div><span>Объём за период</span><Explanation label="Объём за период" text="Сумма неизменяемых событий журнала. Базы объёма не смешиваются." norm={null} /></div>{detail.totals.length ? detail.totals.map(total => <div className="volume-total" key={total.basis}><p><b>{volume(total.volume_m3)} м³</b><span>{basisName(total.basis)} · {total.records} записей</span></p><ProvenanceNotice total={total} /></div>) : <span>Записей выработки нет</span>}</div></section> }

function ProvenanceNotice({ total }: { total: Total }) {
  const unknown = total.provenance?.method_versions.includes('unknown') || total.warnings?.some(warning => /неизвестн/i.test(warning))
  if (!unknown) return null
  return <p className="provenance-warning"><AlertTriangle size={13} />Версия методики неизвестна: объём есть в журнале, но его физическая точность не подтверждена.</p>
}

function FleetView({ fleet, machines }: { fleet: Fleet | null; machines: Machine[] }) { return <div className="content-page"><section className="intro"><p>Суммы построены из журнала событий за выбранный UTC-период. Объём <b>не объединяется</b> между базами измерения и показан с точностью журнала — до 6 знаков после запятой.</p></section>{!fleet ? <Empty>Сводка недоступна.</Empty> : <><div className="total-grid">{fleet.totals.length ? fleet.totals.map(total => <article className="total-card" key={total.basis}><p>{basisName(total.basis)}</p><strong>{volume(total.volume_m3)} <small>м³</small></strong><span>{total.records} записей журнала</span><ProvenanceNotice total={total} /></article>) : <Empty>За выбранный период событий выработки нет.</Empty>}</div><section className="table-card"><div className="section-title"><div><p className="eyebrow">РАСШИФРОВКА ПАРКА</p><h2>{machines.length} машин · {fleet.record_count} записей</h2></div></div><div className="data-table"><div className="table-head"><span>Машина</span><span>Выработка</span><span>Моточасы периода</span></div>{fleet.machines.map(machine => <div className="table-row" key={machine.id}><span><b>{machine.name}</b></span><span>{machine.totals.length ? machine.totals.map(x => <small key={x.basis}>{volume(x.volume_m3)} м³ · {basisName(x.basis)}</small>) : '—'}</span><span>{machine.engine_hours === null ? 'недоступны' : `${machine.engine_hours.toLocaleString('ru-RU')} ч`}</span></div>)}</div></section></>}</div> }

function QualityView({ quality }: { quality: Quality | null }) { return <div className="content-page"><section className="intro"><p>Журнал приёма показывает состояние доставки. «Принято» означает, что запись прошла проверку формата и идемпотентности, но не подтверждает исправность датчика.</p></section>{!quality ? <Empty>Журнал качества пока недоступен.</Empty> : <><div className="quality-counts">{Object.entries(quality.counts).map(([key, value]) => <article key={key}><b>{value}</b><span>{{ accepted: 'принято', duplicates: 'повторно', rejected: 'отклонено' }[key]}</span></article>)}</div><section className="table-card"><div className="section-title"><div><p className="eyebrow">ПОСЛЕДНИЕ ПАКЕТЫ</p><h2>Аудит доставки</h2></div></div>{quality.recent.length ? <div className="data-table"><div className="table-head"><span>Получено</span><span>Статус</span><span>Причина</span></div>{quality.recent.map((item, index) => <div className="table-row" key={`${item.received_at}-${index}`}><span>{displayDate(item.received_at)}</span><span>{item.status}</span><span>{item.reason || '—'}</span></div>)}</div> : <Empty>Приём пакетов ещё не зафиксирован.</Empty>}</section><section className="limitations"><h2>Границы интерпретации</h2>{quality.limitations.map(x => <p key={x}><CircleHelp size={16} />{x}</p>)}</section></>}</div> }

function DataView({ dates }: { dates: { start: string; end: string } }) { const href = `/api/exports/ledger.csv?start=${encodeURIComponent(dates.start)}&end=${encodeURIComponent(dates.end)}`; return <div className="content-page narrow"><section className="data-lead"><Database size={27} /><div><p className="eyebrow">КОНТУР ДАННЫХ</p><h2>Нормализованный журнал, а не обещание универсальной интеграции</h2></div></section><article className="instruction"><h3>Что принимает система</h3><p>Только проверяемый нормализованный JSON: события телеметрии, координаты и дельты выработки. Пакеты имеют идентификаторы; повторная доставка не должна удваивать записи.</p><pre><code>{`python -m edge.outbox send \\
  --endpoint https://ваш-домен/api/ingest \\
  --token "$DEVICE_TOKEN" \\
  --file batch.json`}</code></pre><p className="fine-print">Команда — пример для подготовленного edge-клиента. Она не доказывает поддержку CAN, StanForD, 1С или конкретной бортовой системы.</p></article><article className="instruction"><h3>Журнал для сверки</h3><p>CSV содержит события выработки, источник и метод. Это выгрузка для проверки и сопоставления, <b>не интеграция с 1С</b>.</p><a className="button button--primary" href={href}><Download size={17} />Скачать журнал CSV</a></article><article className="instruction subtle"><h3>Перед подключением</h3><ul><li>Подтвердить доступные интерфейсы, версии ПО и лицензии на конкретной машине.</li><li>Зафиксировать методику объёма, базу «с корой / без коры» и калибровку.</li><li>Проверить накопление, повторную доставку и сверку с приёмкой в полевых условиях.</li></ul></article></div> }

function Documents() { const [documents, setDocuments] = useState<DocumentItem[] | null>(null); const [error, setError] = useState(''); useEffect(() => { request<{ documents: DocumentItem[] }>('/api/documents').then(x => setDocuments(x.documents)).catch(err => setError(err instanceof Error ? err.message : 'Документы недоступны')) }, []); return <div className="content-page narrow"><section className="intro"><p>Материалы отделяют подтверждённые сведения от гипотез и полевых проверок. Ссылки появляются только после получения списка с сервера.</p></section>{error && <div className="message message--error" role="alert">{error}</div>}{documents === null ? <div className="loading">Получаем список документов…</div> : documents.length === 0 ? <Empty>Сервер пока не опубликовал документов.</Empty> : <div className="document-list">{documents.map(doc => <a href={doc.url} key={doc.name} className="document" download><FileText size={22} /><span><b>{doc.title}</b><small>{doc.name}</small></span><em>{doc.format}</em><Download size={18} /></a>)}</div>}</div> }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
