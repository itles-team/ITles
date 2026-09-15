import { FormEvent, useEffect, useRef, useState } from 'react'
import { CircleAlert, Download, FileText, HelpCircle, LogOut, Map as MapIcon, Menu, RefreshCw, Route, ShieldCheck, SlidersHorizontal, TreePine, X } from 'lucide-react'
import L from 'leaflet'
import { MapContainer, Marker, Popup, Polyline, useMap } from 'react-leaflet'
import { api, ApiError, type Document, type FleetData, type Machine, type MachineDetail, type Metric, type Quality, type Session, type Status, type VolumeTotal } from './api'

type View = 'map' | 'fleet' | 'quality' | 'docs'

const utcToday = () => new Date().toISOString().slice(0, 10)
const statusLabels: Record<Status, string> = { fresh: 'актуальные', stale: 'устаревшие', missing: 'нет данных', invalid: 'ошибка данных' }
const navigation: { id: View; label: string; icon: typeof MapIcon }[] = [
  { id: 'map', label: 'Карта производства', icon: MapIcon },
  { id: 'fleet', label: 'Парк и выработка', icon: TreePine },
  { id: 'quality', label: 'Качество данных', icon: ShieldCheck },
  { id: 'docs', label: 'Исследования и документы', icon: FileText },
]

function formatDate(value: string | null) {
  if (!value) return 'нет отметки времени'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'некорректная дата' : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
}

function age(value: string | null) {
  if (!value) return 'время неизвестно'
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60000))
  if (!Number.isFinite(minutes)) return 'время некорректно'
  if (minutes < 2) return 'получено менее 2 мин назад'
  if (minutes < 60) return `получено ${minutes} мин назад`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `получено ${hours} ч назад` : `получено ${Math.floor(hours / 24)} дн назад`
}

function decimal(value: string | number | null, maximumFractionDigits = 2) {
  if (value === null) return '—'
  const number = Number(value)
  return Number.isFinite(number) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits }).format(number) : '—'
}

function machineIcon(status: Status) {
  return L.divIcon({ className: 'machine-icon-wrap', html: `<span class="machine-icon ${status}" aria-hidden="true"></span>`, iconSize: [20, 20], iconAnchor: [10, 10] })
}

function FitPositions({ machines, selected }: { machines: Machine[]; selected: string | null }) {
  const map = useMap()
  useEffect(() => {
    const active = selected ? machines.filter((machine) => machine.id === selected) : machines
    const points = active.flatMap((machine) => machine.position ? [[machine.position.latitude, machine.position.longitude] as L.LatLngTuple] : [])
    if (points.length === 1) map.setView(points[0], 9)
    else if (points.length > 1) map.fitBounds(points, { padding: [64, 64], maxZoom: 9 })
  }, [map, machines, selected])
  return null
}

function StatusTag({ status }: { status: Status }) {
  return <span className={`status-tag ${status}`}><span aria-hidden="true" />{statusLabels[status]}</span>
}

function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="error-notice" role="alert"><CircleAlert size={18} /><div>{error}{retry && <button className="text-button" onClick={retry}>Повторить</button>}</div></div>
}

function InfoButton({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const close = () => {
    setOpen(false)
    window.setTimeout(() => trigger.current?.focus(), 0)
  }
  useEffect(() => {
    if (!open) return
    const keepFocusInDialog = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keepFocusInDialog)
    return () => window.removeEventListener('keydown', keepFocusInDialog)
  }, [open])
  return <>
    <button ref={trigger} className="info-button" aria-label={`Пояснение: ${title}`} onClick={() => setOpen(true)}><HelpCircle size={15} /></button>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section ref={dialog} className="info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading"><h2 id="info-title">{title}</h2><button className="icon-button" aria-label="Закрыть пояснение" autoFocus onClick={close}><X size={18} /></button></div>
        <div className="dialog-copy">{children}</div>
        <button className="secondary-button" onClick={close}>Понятно</button>
      </section>
    </div>}
  </>
}

function DateRange({ start, end, onChange }: { start: string; end: string; onChange: (start: string, end: string) => void }) {
  const updateStart = (value: string) => onChange(value, end < value ? value : end)
  return <div className="date-range" aria-label="Период отчёта в UTC">
    <label>С <input type="date" value={start} max={end} onChange={(event) => updateStart(event.target.value)} /></label>
    <span>—</span>
    <label>По <input type="date" value={end} min={start} max={utcToday()} onChange={(event) => onChange(start, event.target.value)} /></label>
    <InfoButton title="Границы периода">Дата начала включается с 00:00 UTC, дата окончания — до 23:59:59 UTC. Часовой пояс выбран явно, чтобы отчёт не менялся на границе смены.</InfoButton>
  </div>
}

function Login({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { onAuthenticated(await api.login(account, password)); setPassword('') } catch (err) { setError(err instanceof Error ? err.message : 'Не удалось войти.') } finally { setBusy(false) }
  }
  const demo = async () => {
    setBusy(true); setError('')
    try { onAuthenticated(await api.demo()) } catch (err) { setError(err instanceof Error ? err.message : 'Учебный парк пока недоступен.') } finally { setBusy(false) }
  }
  return <main className="login-page">
    <section className="login-intro"><div className="brand-mark"><TreePine size={24} /></div><p className="eyebrow">ИТлес / производственная карта</p><h1>Данные техники —<br />без домыслов.</h1><p>Показываем только принятые системой события и последнюю известную позицию. Подключение к машине и доступность каждого параметра подтверждаются отдельно.</p><div className="login-principles"><span>Без персональных данных</span><span>UTC в журнале</span><span>Без сторонних карт</span></div></section>
    <section className="login-panel" aria-labelledby="login-title"><p className="eyebrow">Вход организации</p><h2 id="login-title">Открыть рабочий парк</h2><p className="muted">Используйте код организации и пароль. Мы не запрашиваем имя, телефон или электронную почту.</p>
      <form onSubmit={submit}>
        <label>Код организации<input autoComplete="username" value={account} onChange={(event) => setAccount(event.target.value)} required /></label>
        <label>Пароль<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        {error && <ErrorNotice error={error} />}
        <button className="primary-button" disabled={busy} type="submit">{busy ? 'Проверяем…' : 'Войти'}</button>
      </form>
      <div className="or"><span />или<span /></div>
      <button className="demo-button" onClick={demo} disabled={busy}>Открыть учебный парк <span>синтетические данные</span></button>
    </section>
  </main>
}

function MapSurface({ machines, selected, onSelect, detail }: { machines: Machine[]; selected: string | null; onSelect: (id: string) => void; detail: MachineDetail | null }) {
  const locations = machines.filter((machine) => machine.position)
  const initial: L.LatLngTuple = locations[0]?.position ? [locations[0].position.latitude, locations[0].position.longitude] : [61.5, 96]
  const track = detail?.track.map((point) => [point.latitude, point.longitude] as L.LatLngTuple) ?? []
  return <div className="map-surface" aria-label="Карта последних известных координат машин">
    <MapContainer center={initial} zoom={4} zoomControl={false} scrollWheelZoom className="leaflet-map">
      <FitPositions machines={machines} selected={selected} />
      {track.length > 1 && <Polyline positions={track} pathOptions={{ color: '#167b72', weight: 3, dashArray: '5 7' }} />}
      {locations.map((machine) => machine.position && <Marker key={machine.id} position={[machine.position.latitude, machine.position.longitude]} icon={machineIcon(machine.position.status)} eventHandlers={{ click: () => onSelect(machine.id) }}>
        <Popup><strong>{machine.name}</strong><br />Последняя известная позиция<br />{formatDate(machine.position.observed_at)}</Popup>
      </Marker>)}
    </MapContainer>
    <div className="map-grid" aria-hidden="true" />
    <div className="map-note"><MapIcon size={15} /><span><strong>Офлайн-подложка</strong> не загружена: здесь отображаются координаты без стороннего картографического сервиса.</span></div>
    <div className="map-legend"><span><i className="dot fresh" />актуально</span><span><i className="dot stale" />устарело</span><span><i className="dot missing" />нет координат</span></div>
  </div>
}

function MachineList({ machines, selected, onSelect }: { machines: Machine[]; selected: string | null; onSelect: (id: string) => void }) {
  return <section className="machine-list"><div className="section-heading"><div><p className="eyebrow">Машины</p><h2>{machines.length} в учёте</h2></div><InfoButton title="Статус соединения">Это статус последнего полученного системой сообщения. Он не доказывает, что машина физически работает или находится онлайн сейчас.</InfoButton></div>
    {machines.length === 0 ? <p className="empty-state">В этом аккаунте пока нет машин.</p> : <ul>{machines.map((machine) => <li key={machine.id}><button className={selected === machine.id ? 'selected' : ''} onClick={() => onSelect(machine.id)}><span className={`machine-dot ${machine.connection_status}`} /><span className="machine-list-copy"><strong>{machine.name}</strong><small>{machine.model || 'Модель не указана'} · {age(machine.last_seen)}</small></span><StatusTag status={machine.connection_status} /></button></li>)}</ul>}
  </section>
}

function MetricRow({ metric }: { metric: Metric }) {
  return <div className="metric-row"><div className="metric-label"><span>{metric.label}</span><InfoButton title={metric.label}><p>{metric.explanation || 'Описание этого параметра не предоставлено источником данных.'}</p><p><strong>Источник:</strong> {metric.source || 'не указан'}</p><p><strong>Норма:</strong> {metric.norm || 'Норма не подтверждена для этой модели и узла.'}</p></InfoButton></div><div className="metric-reading"><strong>{metric.value === null ? '—' : `${decimal(metric.value)} ${metric.unit}`}</strong><small>{formatDate(metric.observed_at)}</small></div><StatusTag status={metric.status} /></div>
}

function DetailsPanel({ detail, loading, error, close }: { detail: MachineDetail | null; loading: boolean; error: string; close: () => void }) {
  return <aside className="details-panel" aria-label="Карточка машины">{loading && <div className="panel-loading">Загружаем карточку машины…</div>}{error && <ErrorNotice error={error} />}{detail && <>
    <div className="details-head"><div><p className="eyebrow">Карточка машины</p><h2>{detail.name}</h2><p className="muted">{[detail.model, detail.head, detail.computer].filter(Boolean).join(' · ') || 'Конфигурация не указана'}</p></div><button className="icon-button close-panel" onClick={close} aria-label="Закрыть карточку"><X size={18} /></button></div>
    <div className="position-box"><Route size={18} /><div><strong>Последняя известная позиция</strong><p>{detail.position ? `${detail.position.latitude.toFixed(5)}, ${detail.position.longitude.toFixed(5)} · ${age(detail.position.observed_at)}` : 'Координаты не получены'}</p></div>{detail.position && <StatusTag status={detail.position.status} />}</div>
    <section className="detail-section"><div className="section-heading"><h3>Выработка за период</h3><InfoButton title="Основание объёма">Разные основания объёма не суммируются. Сверяйте каждую строку с первичным источником и методикой.</InfoButton></div><Totals totals={detail.totals} /><p className="detail-foot">{detail.production.length ? `Событий в карточке: ${detail.production.length}` : 'Событий производства за период нет.'}</p></section>
    <section className="detail-section"><div className="section-heading"><h3>Доступные параметры</h3><span className="subtle">{detail.engine_hours === null ? 'моточасы не получены' : `${decimal(detail.engine_hours, 1)} ч`}</span></div>{detail.metrics.length ? detail.metrics.map((metric) => <MetricRow key={metric.key} metric={metric} />) : <p className="empty-state">Параметры не поступали. Это не означает нулевые значения.</p>}</section>
  </>}</aside>
}

function Totals({ totals }: { totals: VolumeTotal[] }) {
  if (!totals.length) return <p className="empty-state">Записей объёма за период нет.</p>
  return <div className="totals">{totals.map((total) => <div key={total.basis}><span>{total.basis}</span><strong>{decimal(total.volume_m3)} м³</strong><small>{total.records} {total.records === 1 ? 'запись' : 'записей'}</small></div>)}</div>
}

function FleetView({ fleet, loading, error }: { fleet: FleetData | null; loading: boolean; error: string }) {
  return <main className="content-view"><header className="view-header"><p className="eyebrow">Сводка без смешения методик</p><h1>Парк и выработка</h1><p>Каждое основание объёма показано отдельно. Итог не считается, если первичные записи несопоставимы.</p></header>{loading && <p className="page-loading">Собираем сводку…</p>}{error && <ErrorNotice error={error} />}{fleet && <><section className="fleet-totals"><div className="section-heading"><h2>Объём за выбранный период</h2><span>{fleet.record_count} принятых записей</span></div><Totals totals={fleet.totals} /></section><section className="ledger"><div className="section-heading"><h2>Разложение по машинам</h2><span>{fleet.period.start} — {fleet.period.end} UTC</span></div>{fleet.machines.length ? <table><thead><tr><th>Машина</th><th>Объём по основаниям</th><th>Моточасы</th></tr></thead><tbody>{fleet.machines.map((machine) => <tr key={machine.id}><td><strong>{machine.name}</strong></td><td>{machine.totals.length ? machine.totals.map((total) => <div className="table-total" key={total.basis}>{total.basis}: <b>{decimal(total.volume_m3)} м³</b> <small>({total.records})</small></div>) : '—'}</td><td>{machine.engine_hours === null ? 'нет данных' : `${decimal(machine.engine_hours, 1)} ч`}</td></tr>)}</tbody></table> : <p className="empty-state">Принятых записей за период нет.</p>}</section></>}</main>
}

function QualityView({ data, loading, error }: { data: Quality | null; loading: boolean; error: string }) {
  return <main className="content-view"><header className="view-header"><p className="eyebrow">Контроль цепочки приёма</p><h1>Качество данных</h1><p>Журнал показывает результат обработки входящих записей, а не техническое состояние харвестера.</p></header>{loading && <p className="page-loading">Читаем журнал обработки…</p>}{error && <ErrorNotice error={error} />}{data && <><section className="quality-counts"><div><span>Принято</span><strong>{data.counts.accepted}</strong></div><div><span>Дубликаты</span><strong>{data.counts.duplicates}</strong></div><div><span>Отклонено</span><strong>{data.counts.rejected}</strong></div></section><section className="limitations"><h2>Границы интерпретации</h2>{data.limitations.length ? <ul>{data.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="empty-state">Ограничения не переданы сервером.</p>}</section><section className="ingest-note"><h2>Формат приёма</h2><p>Сервис принимает нормализованный JSON через серверный API. На этом этапе не подтверждена совместимость с CAN, StanForD, бортовыми компьютерами или 1С — для каждого источника требуется отдельная проверка.</p><code>python -m edge.outbox enqueue ./events.json</code><p>Команда только ставит подготовленный файл в локальную очередь. Отправка требует отдельного настроенного устройства; успех подтверждается только новой записью в журнале выше. Загрузка из браузера здесь намеренно не имитируется.</p></section><section className="ledger"><h2>Последние входящие записи</h2>{data.recent.length ? <table><thead><tr><th>Получено</th><th>Статус</th><th>Машина</th><th>Причина</th></tr></thead><tbody>{data.recent.map((item, index) => <tr key={`${item.received_at}-${index}`}><td>{formatDate(item.received_at)}</td><td><StatusTag status={item.status} /></td><td>{item.machine_id || 'не определена'}</td><td>{item.reason || '—'}</td></tr>)}</tbody></table> : <p className="empty-state">В журнале пока нет записей.</p>}</section></>}</main>
}

function DocsView({ docs, loading, error }: { docs: Document[] | null; loading: boolean; error: string }) {
  return <main className="content-view"><header className="view-header"><p className="eyebrow">Материалы внедрения</p><h1>Исследования и документы</h1><p>Здесь доступны только документы, которые выдал сервер организации. Их содержание и источники следует проверять перед применением на машине.</p></header>{loading && <p className="page-loading">Запрашиваем документы…</p>}{error && <ErrorNotice error={error} />}{docs && <section className="documents">{docs.length ? docs.map((document) => <a key={document.name} href={document.url} download={document.name}><FileText size={22} /><span><strong>{document.title}</strong><small>{document.name} · {document.format}</small></span><Download size={18} aria-label={`Скачать ${document.title}`} /></a>) : <p className="empty-state">Сервер ещё не опубликовал документы для этого аккаунта.</p>}</section>}</main>
}

function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [view, setView] = useState<View>('map'); const [drawer, setDrawer] = useState(false)
  const [start, setStart] = useState(utcToday); const [end, setEnd] = useState(utcToday)
  const [machines, setMachines] = useState<Machine[]>([]); const [selected, setSelected] = useState<string | null>(null)
  const [machineDetail, setMachineDetail] = useState<MachineDetail | null>(null); const [fleet, setFleet] = useState<FleetData | null>(null); const [quality, setQuality] = useState<Quality | null>(null); const [docs, setDocs] = useState<Document[] | null>(null)
  const [loading, setLoading] = useState(false); const [detailLoading, setDetailLoading] = useState(false); const [error, setError] = useState(''); const [detailError, setDetailError] = useState('')
  const [detailVersion, setDetailVersion] = useState(0)
  const currentRequest = useRef(0)
  const load = async () => {
    const request = ++currentRequest.current; setLoading(true); setError('')
    try {
      if (view === 'map') { const data = await api.machines(); if (request === currentRequest.current) { setMachines(data.machines); setSelected((active) => active && data.machines.some((machine) => machine.id === active) ? active : data.machines[0]?.id || null); setDetailVersion((version) => version + 1) } }
      if (view === 'fleet') setFleet(await api.fleet(start, end))
      if (view === 'quality') setQuality(await api.quality())
      if (view === 'docs') setDocs((await api.documents()).documents)
    } catch (err) { if (request === currentRequest.current) setError(err instanceof Error ? err.message : 'Не удалось загрузить данные.') } finally { if (request === currentRequest.current) setLoading(false) }
  }
  useEffect(() => { void load() }, [view, start, end]) // explicit refresh, no polling
  useEffect(() => {
    if (!selected || view !== 'map') { setMachineDetail(null); return }
    let cancelled = false; setDetailLoading(true); setDetailError('')
    api.machine(selected, start, end).then((data) => { if (!cancelled) setMachineDetail(data) }).catch((err) => { if (!cancelled) setDetailError(err instanceof Error ? err.message : 'Не удалось получить карточку.') }).finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [selected, start, end, view, detailVersion])
  const changeView = (next: View) => { setView(next); setDrawer(false) }
  const downloadUrl = `/api/exports/ledger.csv?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  return <div className="app-shell">
    <aside className={`sidebar ${drawer ? 'open' : ''}`} aria-label="Основная навигация"><div className="sidebar-brand"><div className="brand-mark"><TreePine size={20} /></div><span>ИТлес<small>производственная карта</small></span><button className="icon-button mobile-only" onClick={() => setDrawer(false)} aria-label="Закрыть меню"><X size={20} /></button></div>
      <nav>{navigation.map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => changeView(item.id)} className={view === item.id ? 'active' : ''}><Icon size={18} />{item.label}</button> })}</nav>
      <div className="sidebar-footer"><div className="org"><span>{session.organization.name}</span><small>{session.demo ? 'учебный контур' : 'контур организации'}</small></div><button onClick={onLogout}><LogOut size={17} />Выйти</button></div>
    </aside>{drawer && <button className="drawer-backdrop" aria-label="Закрыть меню" onClick={() => setDrawer(false)} />}
    <section className="workspace"><header className="topbar"><button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setDrawer(true)}><Menu size={21} /></button><div className="topbar-title"><span>{navigation.find((item) => item.id === view)?.label}</span>{session.demo && <b>Учебные данные</b>}</div><div className="topbar-actions"><DateRange start={start} end={end} onChange={(newStart, newEnd) => { setStart(newStart); setEnd(newEnd) }} />{view === 'fleet' && <a className="export-button" href={downloadUrl}><Download size={16} />CSV-журнал</a>}<button className="refresh-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} />Обновить</button></div></header>
      {session.demo && <div className="demo-ribbon"><CircleAlert size={16} /><span><strong>Учебный парк.</strong> Это синтетический контур для проверки интерфейса; он не подтверждает связь с техникой.</span></div>}
      {view === 'map' && <main className="map-workspace"><MachineList machines={machines} selected={selected} onSelect={setSelected} /><MapSurface machines={machines} selected={selected} onSelect={setSelected} detail={machineDetail} /><DetailsPanel detail={machineDetail} loading={detailLoading} error={detailError} close={() => setSelected(null)} />{error && <div className="map-error"><ErrorNotice error={error} retry={() => void load()} /></div>}</main>}
      {view === 'fleet' && <FleetView fleet={fleet} loading={loading} error={error} />}{view === 'quality' && <QualityView data={quality} loading={loading} error={error} />}{view === 'docs' && <DocsView docs={docs} loading={loading} error={error} />}
      <footer className="workspace-foot"><SlidersHorizontal size={14} />Статусы относятся к данным в системе. «Актуально» не означает соответствие OEM-норме.</footer>
    </section>
  </div>
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null); const [checking, setChecking] = useState(true)
  useEffect(() => { api.me().then(setSession).catch((err) => { if (!(err instanceof ApiError && err.status === 401)) console.warn('Session check failed', err) }).finally(() => setChecking(false)) }, [])
  if (checking) return <div className="initial-loading">Проверяем доступ к производственной карте…</div>
  if (!session) return <Login onAuthenticated={setSession} />
  return <Dashboard session={session} onLogout={() => { api.logout().catch(() => undefined).finally(() => setSession(null)) }} />
}
