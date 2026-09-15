import React, {
  FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  CircleMarker,
  GeoJSON,
  MapContainer,
  Polyline,
  Tooltip,
} from "react-leaflet";
import L from "leaflet";
import type { GeoJsonObject } from "geojson";
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Database,
  Download,
  FileText,
  LogOut,
  Map as MapIcon,
  Menu,
  RefreshCw,
  Route,
  ShieldCheck,
  Trees,
  X,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import naturalEarthRussiaRegionText from "./assets/natural-earth-russia-region.geojson?raw";

type Status = "fresh" | "stale" | "missing" | "invalid";
type Metric = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  observed_at: string | null;
  status: Status;
  source: string;
  explanation: string;
  norm: string | null;
};
type Position = {
  latitude: number;
  longitude: number;
  observed_at: string;
  status: Status;
};
type Machine = {
  id: string;
  name: string;
  model: string | null;
  head: string | null;
  computer: string | null;
  connection_status: Status;
  metrics: Metric[];
  position: Position | null;
  last_seen: string | null;
};
type Provenance = {
  sources: string[];
  methods: string[];
  method_versions: string[];
  calibration_refs: string[];
};
type Total = {
  basis: "under_bark" | "over_bark" | "unknown";
  volume_m3: string;
  records: number;
  provenance?: Provenance;
  warnings?: string[];
};
type Fleet = {
  period: { start: string; end: string };
  totals: Total[];
  machines: {
    id: string;
    name: string;
    totals: Total[];
    engine_hours: number | null;
  }[];
  record_count: number;
};
type MachineDetail = Machine & {
  production: {
    event_id: string;
    occurred_at: string;
    volume_m3: string;
    basis: string;
    source: string;
    method: string;
    method_version: string;
    calibration_ref: string | null;
  }[];
  totals: Total[];
  track: { latitude: number; longitude: number; observed_at: string }[];
  engine_hours: number | null;
};
type Quality = {
  counts: { accepted: number; duplicates: number; rejected: number };
  recent: {
    received_at: string;
    status: string;
    reason: string | null;
    machine_id: string | null;
  }[];
  limitations: string[];
};
type DocumentItem = {
  name: string;
  title: string;
  url: string;
  format: string;
};
type DateRange = { start: string; end: string };
type Session = {
  organization: { id: string; name: string };
  demo: boolean;
  data_period?: DateRange;
};

const today = new Date().toISOString().slice(0, 10);
const naturalEarthRussiaRegion = JSON.parse(
  naturalEarthRussiaRegionText,
) as GeoJsonObject;
const nav = [
  ["map", "Карта производства", MapIcon],
  ["fleet", "Парк и объём", BarChart3],
  ["quality", "Качество данных", ShieldCheck],
  ["data", "Передача данных", Database],
  ["docs", "Исследования", BookOpen],
] as const;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new Error(
      "Сервер недоступен. Проверьте соединение и повторите запрос.",
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      detail?: string;
    };
    throw new Error(body.detail || `Ошибка запроса (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function hasValidDateRange({ start, end }: { start: string; end: string }) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(end) &&
    start <= end
  );
}

function initialDates(session: Session): DateRange {
  if (
    session.demo &&
    session.data_period &&
    hasValidDateRange(session.data_period)
  ) {
    return session.data_period;
  }
  return { start: today, end: today };
}

function useMediaQuery(query: string) {
  const getMatches = () =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}

function displayDate(value: string | null) {
  if (!value) return "нет данных";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(date) + " UTC";
}
function observationAge(value: string | null) {
  if (!value) return "не поступало";
  if (new Date(value).getTime() > Date.now())
    return "время наблюдения опережает часы браузера";
  const hours = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000),
  );
  return hours < 1
    ? "наблюдалось менее часа назад"
    : hours < 24
      ? `наблюдалось ${hours} ч назад`
      : `наблюдалось ${Math.floor(hours / 24)} дн. назад`;
}
function basisName(basis: string) {
  return basis === "under_bark"
    ? "без коры"
    : basis === "over_bark"
      ? "с корой"
      : "база не указана";
}
function statusLabel(status: Status) {
  return (
    {
      fresh: "актуальные",
      stale: "устарели",
      missing: "нет данных",
      invalid: "ошибка данных",
    } as Record<Status, string>
  )[status];
}
function metricValue(metric: Metric) {
  return metric.value === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(
        metric.value,
      );
}
function volume(value: string) {
  const [integer, fraction = ""] = value.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const significantFraction = fraction.slice(0, 6).replace(/0+$/, "");
  return significantFraction ? `${grouped},${significantFraction}` : grouped;
}

function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`status status--${status}`}>
      <i />
      {statusLabel(status)}
    </span>
  );
}
function Explanation({
  label,
  text,
  norm,
}: {
  label: string;
  text: string;
  norm: string | null;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    const opener = trigger.current;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "Tab") {
        const controls = focusable();
        if (!controls.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", close);
      opener?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="explanation"
        aria-label={`${label}: открыть пояснение`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        onClick={() => setOpen(true)}
      >
        <CircleHelp size={15} />
      </button>
      {open &&
        createPortal(
          <div
            className="modal-scrim"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <div
              id={dialogId}
              className="metric-modal"
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby={headingId}
              aria-describedby={descriptionId}
            >
              <div>
                <p className="eyebrow">ПОЯСНЕНИЕ ПОКАЗАТЕЛЯ</p>
                <h2 id={headingId}>{label}</h2>
              </div>
              <button
                type="button"
                className="modal-close"
                aria-label="Закрыть пояснение"
                onClick={() => setOpen(false)}
              >
                <X size={18} />
              </button>
              <p id={descriptionId}>{text}</p>
              <p className="modal-norm">
                {norm
                  ? `Норма: ${norm}`
                  : "Норма не подтверждена для этой машины и узла."}
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <Database size={22} />
      <p>{children}</p>
    </div>
  );
}

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      onSession(
        await request<Session>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ account, password }),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }
  async function demo() {
    setError("");
    setBusy(true);
    try {
      onSession(await request<Session>("/api/auth/demo", { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Учебный парк недоступен");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-shell">
      <section className="login-brand">
        <div className="brand-mark">
          <Trees size={27} />
        </div>
        <p className="eyebrow">ПРОИЗВОДСТВЕННАЯ ТЕЛЕМЕТРИЯ</p>
        <h1>ИТлес</h1>
        <p>
          Карта, журнал и происхождение данных — без подмены измерений
          прогнозами.
        </p>
        <div className="login-note">
          <ShieldCheck size={18} />
          Вход по коду организации. Используйте только код и пароль организации;
          не передавайте персональные данные в полях входа.
        </div>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">ЗАЩИЩЁННЫЙ ДОСТУП</p>
        <h2 id="login-title">Открыть свой парк</h2>
        <form onSubmit={login}>
          <label>
            Код организации
            <input
              autoComplete="username"
              required
              minLength={2}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="Например: les-001"
            />
          </label>
          <label>
            Пароль
            <input
              autoComplete="current-password"
              required
              minLength={12}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Не менее 12 символов"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button button--primary" disabled={busy}>
            {busy ? "Проверяем…" : "Войти в организацию"}
            <ChevronRight size={18} />
          </button>
        </form>
        <div className="login-divider">
          <span>или</span>
        </div>
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={demo}
        >
          Открыть учебный парк <ChevronRight size={18} />
        </button>
        <p className="fine-print">
          Учебный парк содержит демонстрационные записи и не подтверждает
          подключение к технике.
        </p>
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    request<Session>("/api/auth/me")
      .then(setSession)
      .catch(() => null)
      .finally(() => setChecked(true));
  }, []);
  if (!checked)
    return (
      <div className="splash">
        <Trees size={26} />
        Загрузка ИТлес
      </div>
    );
  return session ? (
    <Workspace session={session} onLogout={() => setSession(null)} />
  ) : (
    <Login onSession={setSession} />
  );
}

export function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const [view, setView] = useState<(typeof nav)[number][0]>("map");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dates, setDates] = useState(() => initialDates(session));
  const [machines, setMachines] = useState<Machine[]>([]);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [detail, setDetail] = useState<MachineDetail | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loadedPeriod, setLoadedPeriod] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(selected);
  const loadRequest = useRef(0);
  const detailRequest = useRef(0);
  const loadAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const isMobileNavigation = useMediaQuery("(max-width: 850px)");
  const validDates = hasValidDateRange(dates);
  const query = `start=${encodeURIComponent(dates.start)}&end=${encodeURIComponent(dates.end)}`;
  const period = `${dates.start}:${dates.end}`;

  useEffect(
    () => () => {
      loadAbort.current?.abort();
      detailAbort.current?.abort();
      ++loadRequest.current;
      ++detailRequest.current;
    },
    [],
  );

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(
    async (manual = false) => {
      if (manual) setRefreshVersion((value) => value + 1);
      const requestId = ++loadRequest.current;
      loadAbort.current?.abort();
      detailAbort.current?.abort();
      ++detailRequest.current;
      setDetail(null);
      setFleet(null);
      setLoadedPeriod(null);

      if (!hasValidDateRange(dates)) {
        setError("");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const controller = new AbortController();
      loadAbort.current = controller;
      setError("");
      manual ? setRefreshing(true) : setLoading(true);
      try {
        const [machinePayload, fleetPayload] = await Promise.all([
          request<{ machines: Machine[] }>("/api/machines", {
            signal: controller.signal,
          }),
          request<Fleet>(`/api/fleet?${query}`, { signal: controller.signal }),
        ]);
        if (requestId !== loadRequest.current) return;
        setMachines(machinePayload.machines);
        setFleet(fleetPayload);
        const id =
          selectedRef.current &&
          machinePayload.machines.some((m) => m.id === selectedRef.current)
            ? selectedRef.current
            : (machinePayload.machines[0]?.id ?? null);
        setSelected(id);
        setLoadedPeriod(period);
      } catch (err) {
        if (requestId !== loadRequest.current || isAbortError(err)) return;
        setError(
          err instanceof Error ? err.message : "Не удалось получить данные",
        );
      } finally {
        if (requestId !== loadRequest.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [dates, period, query],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected || !validDates || loadedPeriod !== period) {
      detailAbort.current?.abort();
      ++detailRequest.current;
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    detailAbort.current?.abort();
    detailAbort.current = controller;
    const requestId = ++detailRequest.current;
    setDetail(null);
    request<MachineDetail>(
      `/api/machines/${encodeURIComponent(selected)}?${query}`,
      { signal: controller.signal },
    )
      .then((payload) => {
        if (requestId === detailRequest.current) setDetail(payload);
      })
      .catch((err) => {
        if (requestId !== detailRequest.current || isAbortError(err)) return;
        setError(
          err instanceof Error ? err.message : "Не удалось открыть машину",
        );
      });
    return () => controller.abort();
  }, [loadedPeriod, period, query, selected, validDates]);

  useEffect(() => {
    if (view !== "quality") return;
    const controller = new AbortController();
    request<Quality>("/api/quality", { signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted) setQuality(payload);
      })
      .catch(
        (err) =>
          !controller.signal.aborted &&
          setError(
            err instanceof Error ? err.message : "Не удалось загрузить журнал",
          ),
      );
    return () => controller.abort();
  }, [view, refreshVersion]);

  useEffect(() => {
    const navigation = sidebar.current;
    if (!navigation) return;
    if (isMobileNavigation && !open) {
      navigation.setAttribute("inert", "");
      return;
    }
    navigation.removeAttribute("inert");
  }, [isMobileNavigation, open]);

  useEffect(() => {
    if (!open) return;
    const opener = menuButton.current;
    const focusable = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    sidebar.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      opener?.focus();
    };
  }, [open]);

  function changeDates(part: "start" | "end", value: string) {
    // Invalidate immediately: useEffect starts the next request after this render.
    loadAbort.current?.abort();
    ++loadRequest.current;
    detailAbort.current?.abort();
    ++detailRequest.current;
    setDetail(null);
    setFleet(null);
    setLoadedPeriod(null);
    setError("");
    setDates((current) => ({ ...current, [part]: value }));
  }

  function select(id: string) {
    if (id === selected) {
      setOpen(false);
      setView("map");
      return;
    }
    detailAbort.current?.abort();
    ++detailRequest.current;
    setDetail(null);
    setError("");
    setSelected(id);
    setOpen(false);
    setView("map");
  }
  async function logout() {
    setLoggingOut(true);
    try {
      await request("/api/auth/logout", { method: "POST" });
      onLogout();
    } catch {
      setError(
        "Сервер не подтвердил выход. Сеанс мог остаться активным; повторите попытку после восстановления связи.",
      );
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <div className="app-shell">
      <aside
        ref={sidebar}
        id="main-navigation"
        className={`sidebar ${open ? "sidebar--open" : ""}`}
        aria-label="Основная навигация"
        aria-hidden={isMobileNavigation && !open ? true : undefined}
      >
        <div className="sidebar-head">
          <div className="wordmark">
            <Trees size={21} />
            ИТлес
          </div>
          <button
            className="icon-button close-nav"
            aria-label="Закрыть меню"
            type="button"
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
        </div>
        <div className="org-name">{session.organization.name}</div>
        <nav>
          {nav.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              className={view === id ? "nav-item nav-item--active" : "nav-item"}
              aria-current={view === id ? "page" : undefined}
              onClick={() => {
                setView(id);
                setOpen(false);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="privacy">
            <ShieldCheck size={16} />
            Технический контур: не вводите персональные данные
          </div>
          <button
            className="logout"
            type="button"
            onClick={logout}
            disabled={loggingOut}
          >
            <LogOut size={16} />
            Выйти
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="backdrop"
          aria-label="Закрыть меню"
          type="button"
          onClick={() => setOpen(false)}
        />
      )}
      <main className="workspace">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            aria-label="Открыть меню"
            aria-expanded={open}
            aria-controls="main-navigation"
            ref={menuButton}
            type="button"
            onClick={() => setOpen(true)}
          >
            <Menu />
          </button>
          <div>
            <p className="eyebrow">
              {view === "map"
                ? "ОПЕРАЦИОННАЯ КАРТА"
                : "ИТЛЕС / " +
                  nav.find((x) => x[0] === view)?.[1].toUpperCase()}
            </p>
            <h1>
              {view === "map"
                ? "Производственная карта"
                : nav.find((x) => x[0] === view)?.[1]}
            </h1>
          </div>
          {session.demo && <span className="demo-badge">Учебные данные</span>}
          <div className="date-controls">
            <CalendarDays size={17} />
            <label>
              с
              <input
                type="date"
                aria-label="Дата начала периода"
                value={dates.start}
                max={dates.end}
                onChange={(e) => changeDates("start", e.target.value)}
              />
            </label>
            <label>
              по
              <input
                type="date"
                aria-label="Дата окончания периода"
                value={dates.end}
                min={dates.start}
                onChange={(e) => changeDates("end", e.target.value)}
              />
            </label>
          </div>
          <button
            className="refresh"
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing || !validDates}
          >
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            Обновить
          </button>
        </header>
        {!validDates && (
          <div className="message message--error" role="alert">
            Укажите обе даты периода; дата окончания не может быть раньше даты
            начала.
          </div>
        )}
        {error && (
          <div className="message message--error" role="alert">
            <AlertTriangle size={17} />
            {error}
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Закрыть сообщение"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading">Получаем журнал и состояние машин…</div>
        ) : (
          <View
            view={view}
            machines={machines}
            fleet={fleet}
            detail={detail}
            quality={quality}
            selected={selected}
            onSelect={select}
            dates={dates}
            validDates={validDates}
          />
        )}
      </main>
    </div>
  );
}

function View({
  view,
  ...props
}: {
  view: string;
  machines: Machine[];
  fleet: Fleet | null;
  detail: MachineDetail | null;
  quality: Quality | null;
  selected: string | null;
  onSelect: (id: string) => void;
  dates: { start: string; end: string };
  validDates: boolean;
}) {
  if (view === "fleet") return <FleetView {...props} />;
  if (view === "quality") return <QualityView quality={props.quality} />;
  if (view === "data")
    return <DataView dates={props.dates} validDates={props.validDates} />;
  if (view === "docs") return <Documents />;
  return <MapView {...props} />;
}

function MapView({
  machines,
  detail,
  selected,
  onSelect,
}: Omit<Parameters<typeof View>[0], "view" | "fleet" | "quality" | "dates">) {
  const positioned = machines.filter((m) => m.position);
  const center: L.LatLngTuple = positioned.length
    ? [
        positioned.reduce((sum, m) => sum + m.position!.latitude, 0) /
          positioned.length,
        positioned.reduce((sum, m) => sum + m.position!.longitude, 0) /
          positioned.length,
      ]
    : [61.5, 90];
  return (
    <div className="map-layout">
      <section
        className="map-stage"
        aria-label="Карта последних известных позиций"
      >
        <MapContainer
          center={center}
          zoom={5}
          scrollWheelZoom
          className="offline-map"
          zoomControl={false}
          attributionControl={false}
        >
          <GeoJSON
            data={naturalEarthRussiaRegion}
            style={{
              color: "#75988b",
              weight: 1,
              fillColor: "#cfddcc",
              fillOpacity: 0.72,
            }}
          />
          <div className="map-label map-label--north">
            РОССИЯ И СОПРЕДЕЛЬНЫЕ ТЕРРИТОРИИ
          </div>
          <div className="map-grid-note">
            Карта работает без внешних тайлов. Показаны только координаты,
            принятые системой.
          </div>
          {detail?.track && detail.track.length > 1 && (
            <Polyline
              positions={detail.track.map((p) => [p.latitude, p.longitude])}
              pathOptions={{ color: "#78a99d", weight: 2, dashArray: "5 7" }}
            />
          )}
          {positioned.map((machine) => (
            <CircleMarker
              key={machine.id}
              center={[machine.position!.latitude, machine.position!.longitude]}
              radius={machine.id === selected ? 10 : 7}
              pathOptions={{
                color: "#12342f",
                fillColor: machine.id === selected ? "#eeac4a" : "#2e8170",
                fillOpacity: 1,
                weight: 3,
              }}
              eventHandlers={{ click: () => onSelect(machine.id) }}
            >
              <Tooltip direction="top" opacity={1}>
                {machine.name}
                <br />
                <small>
                  {statusLabel(machine.position!.status)} ·{" "}
                  {observationAge(machine.position!.observed_at)}
                </small>
              </Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
        <div className="map-legend">
          <span>
            <i className="legend-dot" />
            последняя известная позиция
          </span>
          <span>
            <Route size={14} />
            линия — полученные точки периода
          </span>
        </div>
        <div className="map-attribution">
          Границы: Natural Earth, Admin 0 Countries 1:110m · public domain
        </div>
      </section>
      <aside className="machine-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ТЕХНИКА</p>
            <h2>{machines.length} ед.</h2>
          </div>
          <span>Выберите на карте</span>
        </div>
        <p className="current-data-note">
          Текущие показатели и последняя позиция берутся из последних принятых
          наблюдений и не ограничены выбранным периодом.
        </p>
        <div className="machine-list">
          {machines.length === 0 ? (
            <Empty>Нет машин, доступных этой организации.</Empty>
          ) : (
            machines.map((machine) => (
              <button
                key={machine.id}
                type="button"
                className={`machine-row ${machine.id === selected ? "machine-row--selected" : ""}`}
                onClick={() => onSelect(machine.id)}
              >
                <span
                  className={`signal signal--${machine.connection_status}`}
                />
                <span>
                  <b>{machine.name}</b>
                  <small>{machine.model || "модель не указана"}</small>
                </span>
                <ChevronRight size={17} />
              </button>
            ))
          )}
        </div>
        {detail ? (
          <MachineDetails detail={detail} />
        ) : (
          <Empty>Выберите машину, чтобы открыть карточку.</Empty>
        )}
      </aside>
    </div>
  );
}
function MachineDetails({ detail }: { detail: MachineDetail }) {
  return (
    <section className="detail">
      <div className="detail-title">
        <div>
          <p className="eyebrow">КАРТОЧКА МАШИНЫ</p>
          <h2>{detail.name}</h2>
        </div>
        <StatusPill status={detail.connection_status} />
      </div>
      <p className="machine-spec">
        {[detail.model, detail.head, detail.computer]
          .filter(Boolean)
          .join(" · ") || "Конфигурация не поступала"}
      </p>
      <div className="position-reading">
        <MapIcon size={16} />
        <span>
          <b>Последняя известная позиция</b>
          {detail.position
            ? `${displayDate(detail.position.observed_at)} · ${observationAge(detail.position.observed_at)}`
            : "координаты не поступали"}
        </span>
      </div>
      <div className="metrics">
        {detail.metrics.map((metric) => (
          <div className="metric" key={metric.key}>
            <div>
              <span>{metric.label}</span>
              <Explanation
                label={metric.label}
                text={metric.explanation}
                norm={metric.norm}
              />
            </div>
            <strong>
              {metricValue(metric)}
              <em>{metric.value !== null ? metric.unit : ""}</em>
            </strong>
            <footer>
              <StatusPill status={metric.status} />
              <small>
                {metric.observed_at
                  ? `наблюдение: ${displayDate(metric.observed_at)}`
                  : "не поступал"}
              </small>
            </footer>
            {!metric.norm && <p className="norm-note">Норма не подтверждена</p>}
          </div>
        ))}
      </div>
      <div className="volume-box">
        <div>
          <span>Объём за период</span>
          <Explanation
            label="Объём за период"
            text="Сумма неизменяемых событий журнала. Базы объёма не смешиваются."
            norm={null}
          />
        </div>
        {detail.totals.length ? (
          detail.totals.map((total) => (
            <div className="volume-total" key={total.basis}>
              <p>
                <b>{volume(total.volume_m3)} м³</b>
                <span>
                  {basisName(total.basis)} · {total.records} записей
                </span>
              </p>
              <ProvenanceNotice total={total} />
            </div>
          ))
        ) : (
          <span>Записей выработки нет</span>
        )}
      </div>
    </section>
  );
}

function ProvenanceNotice({ total }: { total: Total }) {
  const provenance = total.provenance;
  const sourceIsUnknown =
    !provenance ||
    provenance.sources.length === 0 ||
    provenance.sources.some(
      (source) =>
        ![
          "onboard_measurement",
          "operator_export",
          "accounting_import",
        ].includes(source),
    );
  const methodIsUnknown =
    !provenance ||
    provenance.methods.length === 0 ||
    provenance.methods.some(
      (method) =>
        !["harvester_onboard", "merchantable_log", "manual_ledger"].includes(
          method,
        ),
    );
  const versionIsUnknown =
    !provenance ||
    provenance.method_versions.length === 0 ||
    provenance.method_versions.some((version) => version === "unknown");
  const unknown =
    sourceIsUnknown ||
    methodIsUnknown ||
    versionIsUnknown ||
    total.warnings?.some((warning) => /неизвестн/i.test(warning));
  if (!unknown) return null;
  return (
    <p className="provenance-warning">
      <AlertTriangle size={13} />
      Источник, метод или версия методики указаны не полностью. Запись остаётся
      в журнале, но требует сверки перед интерпретацией результата.
    </p>
  );
}

export function FleetView({
  fleet,
  machines,
}: {
  fleet: Fleet | null;
  machines: Machine[];
}) {
  return (
    <div className="content-page">
      <section className="intro">
        <p>
          Суммы построены из журнала событий за выбранный UTC-период. Объём{" "}
          <b>не объединяется</b> между базами измерения и показан с точностью
          журнала — до 6 знаков после запятой.
        </p>
      </section>
      {!fleet ? (
        <Empty>Сводка недоступна.</Empty>
      ) : (
        <>
          <div className="total-grid">
            {fleet.totals.length ? (
              fleet.totals.map((total) => (
                <article className="total-card" key={total.basis}>
                  <p>{basisName(total.basis)}</p>
                  <strong>
                    {volume(total.volume_m3)} <small>м³</small>
                  </strong>
                  <span>{total.records} записей журнала</span>
                  <ProvenanceNotice total={total} />
                </article>
              ))
            ) : (
              <Empty>За выбранный период событий выработки нет.</Empty>
            )}
          </div>
          <section className="table-card">
            <div className="section-title">
              <div>
                <p className="eyebrow">РАСШИФРОВКА ПАРКА</p>
                <h2>
                  {machines.length} машин · {fleet.record_count} записей
                </h2>
              </div>
            </div>
            <div className="data-table">
              <div className="table-head">
                <span>Машина</span>
                <span>Выработка</span>
                <span>Изменение счётчика</span>
              </div>
              {fleet.machines.map((machine) => (
                <div className="table-row" key={machine.id}>
                  <span>
                    <b>{machine.name}</b>
                  </span>
                  <span>
                    {machine.totals.length
                      ? machine.totals.map((x) => (
                          <small key={x.basis}>
                            {volume(x.volume_m3)} м³ · {basisName(x.basis)}
                          </small>
                        ))
                      : "—"}
                  </span>
                  <span>
                    {machine.engine_hours === null
                      ? "недоступны"
                      : `${machine.engine_hours.toLocaleString("ru-RU")} ч между наблюдениями`}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function QualityView({ quality }: { quality: Quality | null }) {
  return (
    <div className="content-page">
      <section className="intro">
        <p>
          Счётчики показывают исходы пакетов, а не число событий. «Принято»
          означает, что пакет прошёл проверку формата и идемпотентности, но не
          подтверждает исправность датчика.
        </p>
        <p>
          Журнал организации не включает отклонённые до определения организации
          пакеты: например, без авторизации или превышающие допустимый размер.
        </p>
      </section>
      {!quality ? (
        <Empty>Журнал качества пока недоступен.</Empty>
      ) : (
        <>
          <div className="quality-counts">
            {Object.entries(quality.counts).map(([key, value]) => (
              <article key={key}>
                <b>{value}</b>
                <span>
                  {
                    {
                      accepted: "принято",
                      duplicates: "повторно",
                      rejected: "отклонено",
                    }[key]
                  }
                </span>
              </article>
            ))}
          </div>
          <section className="table-card">
            <div className="section-title">
              <div>
                <p className="eyebrow">ПОСЛЕДНИЕ ПАКЕТЫ</p>
                <h2>Аудит доставки</h2>
              </div>
            </div>
            {quality.recent.length ? (
              <div className="data-table">
                <div className="table-head">
                  <span>Получено</span>
                  <span>Статус</span>
                  <span>Причина</span>
                </div>
                {quality.recent.map((item, index) => (
                  <div
                    className="table-row"
                    key={`${item.received_at}-${index}`}
                  >
                    <span>{displayDate(item.received_at)}</span>
                    <span>{item.status}</span>
                    <span>{item.reason || "—"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>Приём пакетов ещё не зафиксирован.</Empty>
            )}
          </section>
          <section className="limitations">
            <h2>Границы интерпретации</h2>
            {quality.limitations.map((x) => (
              <p key={x}>
                <CircleHelp size={16} />
                {x}
              </p>
            ))}
          </section>
        </>
      )}
    </div>
  );
}

export function DataView({
  dates,
  validDates,
}: {
  dates: { start: string; end: string };
  validDates: boolean;
}) {
  const href = validDates
    ? `/api/exports/ledger.csv?start=${encodeURIComponent(dates.start)}&end=${encodeURIComponent(dates.end)}`
    : undefined;
  return (
    <div className="content-page narrow">
      <section className="data-lead">
        <Database size={27} />
        <div>
          <p className="eyebrow">КОНТУР ДАННЫХ</p>
          <h2>
            Нормализованный журнал, а не обещание универсальной интеграции
          </h2>
        </div>
      </section>
      <article className="instruction">
        <h3>Что принимает система</h3>
        <p>
          Только проверяемый нормализованный JSON: события телеметрии,
          координаты и дельты выработки. Пакеты имеют идентификаторы; повторная
          доставка не должна удваивать записи. Сначала положите пакет в очередь,
          затем отправьте накопленные пакеты на HTTPS origin сервера.
        </p>
        <pre>
          <code>{`python -m edge.outbox enqueue normalized.json
export ITLES_DEVICE_TOKEN="ваш_токен_устройства"
python -m edge.outbox flush \\
  --url https://ваш-домен`}</code>
        </pre>
        <p className="fine-print">
          ITLES_DEVICE_TOKEN передаётся только через переменную окружения и не
          добавляется в команду. URL — HTTPS origin без /api/ingest и других
          путей. Это не доказывает поддержку CAN, StanForD, 1С или конкретной
          бортовой системы.
        </p>
      </article>
      <article className="instruction">
        <h3>Минимальный пакет production</h3>
        <p>
          Значение объёма передаётся десятичной строкой, а версия методики —
          обязательной технической меткой.
        </p>
        <pre>
          <code>{`{
  "schema_version": 1,
  "batch_id": "c2a7e35d-c33d-45c9-8a2e-09c772f0b75b",
  "events": [{
    "event_id": "69a339f6-69ab-4e54-8c4e-dfa7e239a2cb",
    "machine_id": "harvester_01",
    "occurred_at": "2026-01-14T08:30:00Z",
    "kind": "production",
    "volume_m3": "12.500000",
    "basis": "under_bark",
    "source": "onboard_measurement",
    "method": "harvester_onboard",
    "method_version": "hpr-4.2"
  }]
}`}</code>
        </pre>
      </article>
      <article className="instruction">
        <h3>Журнал для сверки</h3>
        <p>
          CSV содержит события выработки, источник и метод. Это выгрузка для
          проверки и сопоставления, <b>не интеграция с 1С</b>.
        </p>
        {href ? (
          <a className="button button--primary" href={href}>
            <Download size={17} />
            Скачать журнал CSV
          </a>
        ) : (
          <p className="fine-print">Укажите корректный период для выгрузки.</p>
        )}
      </article>
      <article className="instruction subtle">
        <h3>Перед подключением</h3>
        <ul>
          <li>
            Подтвердить доступные интерфейсы, версии ПО и лицензии на конкретной
            машине.
          </li>
          <li>
            Зафиксировать методику объёма, базу «с корой / без коры» и
            калибровку.
          </li>
          <li>
            Проверить накопление, повторную доставку и сверку с приёмкой в
            полевых условиях.
          </li>
        </ul>
      </article>
    </div>
  );
}

function Documents() {
  const [documents, setDocuments] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    request<{ documents: DocumentItem[] }>("/api/documents")
      .then((x) => setDocuments(x.documents))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Документы недоступны"),
      );
  }, []);
  return (
    <div className="content-page narrow">
      <section className="intro">
        <p>
          Материалы отделяют подтверждённые сведения от гипотез и полевых
          проверок. Ссылки появляются только после получения списка с сервера.
        </p>
      </section>
      {error && (
        <div className="message message--error" role="alert">
          {error}
        </div>
      )}
      {documents === null ? (
        <div className="loading">Получаем список документов…</div>
      ) : documents.length === 0 ? (
        <Empty>Сервер пока не опубликовал документов.</Empty>
      ) : (
        <div className="document-list">
          {documents.map((doc) => (
            <a href={doc.url} key={doc.name} className="document" download>
              <FileText size={22} />
              <span>
                <b>{doc.title}</b>
                <small>{doc.name}</small>
              </span>
              <em>{doc.format}</em>
              <Download size={18} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
