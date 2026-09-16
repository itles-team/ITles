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
  useMap,
  ZoomControl,
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
  ArrowUpRight,
  Eye,
  EyeOff,
  LayoutDashboard,
  LocateFixed,
  Search,
  Clock3,
} from "lucide-react";
import "leaflet/dist/leaflet.css";
import "./styles.css";
import naturalEarthRussiaRegionText from "./assets/natural-earth-russia-region.geojson?raw";
import { ApiError, request } from "./api";

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
  ["overview", "Обзор парка", LayoutDashboard],
  ["map", "Карта производства", MapIcon],
  ["fleet", "Парк и объём", BarChart3],
  ["quality", "Качество данных", ShieldCheck],
  ["data", "Передача данных", Database],
  ["docs", "Исследования", BookOpen],
] as const;

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

function recordCount(count: number) {
  const form = new Intl.PluralRules("ru").select(count);
  return `${count} ${form === "one" ? "запись" : form === "few" ? "записи" : "записей"}`;
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

function Login({
  onSession,
  demoAvailable,
  initialError,
}: {
  onSession: (session: Session) => void;
  demoAvailable: boolean;
  initialError: string;
}) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"organization" | "demo" | null>(null);
  const [organizationOpen, setOrganizationOpen] = useState(!demoAvailable);
  const [passwordVisible, setPasswordVisible] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy("organization");
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
      setBusy(null);
    }
  }
  async function demo() {
    setError("");
    setBusy("demo");
    try {
      onSession(await request<Session>("/api/auth/demo", { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Учебный парк недоступен");
    } finally {
      setBusy(null);
    }
  }
  return (
    <main className="login-shell" id="main-content">
      <section className="login-brand">
        <div className="login-wordmark">
          <Trees size={24} aria-hidden="true" /> ИТлес{" "}
          <span>Мониторинг лесозаготовки</span>
        </div>
        <div className="login-editorial">
          <p className="eyebrow">От наблюдения — к решению</p>
          <h1>
            Ваш парк.
            <br />
            <span>В поле зрения.</span>
          </h1>
          <p>
            Где техника, какие показания поступили и сколько древесины записано
            в журнале.
          </p>
        </div>
        <div className="login-index" aria-label="Возможности рабочей области">
          <div>
            <span>01</span>
            <b>Машины и координаты</b>
            <small>Последнее известное положение, не имитация движения</small>
          </div>
          <div>
            <span>02</span>
            <b>Выработка за период</b>
            <small>Раздельный учёт с корой и без коры</small>
          </div>
          <div>
            <span>03</span>
            <b>Происхождение данных</b>
            <small>Время, источник и методика каждого результата</small>
          </div>
        </div>
        <p className="login-footnote">
          Версия для проверки · OEM-оборудование и 1С пока не подключены
        </p>
      </section>
      <section className="login-card" aria-labelledby="login-title">
        <p className="eyebrow">Рабочая область</p>
        <h2 id="login-title">
          {demoAvailable ? (
            <>
              Посмотрите, как
              <br />
              устроен парк
            </>
          ) : (
            "Вход в организацию"
          )}
        </h2>
        <p className="login-intro">
          {demoAvailable
            ? "Начните с примера. Для учебного парка не нужны ни регистрация, ни пароль."
            : "Используйте код и пароль, выданные администратором вашей организации."}
        </p>
        {(error || initialError) && (
          <p className="form-error" role="alert">
            {error || initialError}
          </p>
        )}
        {demoAvailable ? (
          <div className="demo-entry">
            <div>
              <span className="demo-label">Учебный парк</span>
              <span>Вымышленные данные</span>
            </div>
            <p>
              Откройте машину, проверьте показания и сопоставьте их с журналом
              выработки.
            </p>
            <button
              className="button button--primary"
              disabled={busy !== null}
              onClick={demo}
            >
              {busy === "demo" ? "Открываем парк…" : "Открыть учебный парк"}
              <ArrowUpRight size={18} />
            </button>
          </div>
        ) : (
          <p className="access-note">
            Учебный вход недоступен на этом сервере. Для работы нужен доступ
            организации.
          </p>
        )}
        <button
          type="button"
          className="organization-toggle"
          aria-expanded={organizationOpen}
          aria-controls="organization-login"
          onClick={() => setOrganizationOpen(!organizationOpen)}
        >
          <span>Уже есть доступ организации?</span>
          <ChevronRight size={18} />
        </button>
        <div id="organization-login" hidden={!organizationOpen}>
          <p className="access-note">
            Код и пароль выдаёт администратор после создания организации. Эта
            форма не регистрирует новый аккаунт.
          </p>
          <form onSubmit={login} aria-label="Вход в организацию">
            <label>
              Код организации
              <input
                autoComplete="username"
                required
                minLength={2}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="Код, выданный администратором"
              />
            </label>
            <label className="password-label">
              Пароль
              <span className="password-field">
                <input
                  autoComplete="current-password"
                  required
                  minLength={12}
                  type={passwordVisible ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Пароль организации"
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={
                    passwordVisible ? "Скрыть пароль" : "Показать пароль"
                  }
                  aria-pressed={passwordVisible}
                  onClick={() => setPasswordVisible(!passwordVisible)}
                >
                  {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </label>
            <button
              className="button button--secondary"
              disabled={busy !== null}
            >
              {busy === "organization" ? "Проверяем…" : "Войти в организацию"}
              <ChevronRight size={18} />
            </button>
          </form>
        </div>
        <p className="fine-print">
          В учебном парке можно проверить интерфейс и расчёты. Подключение к
          реальному харвестеру он не подтверждает.
        </p>
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [initialError, setInitialError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const report = (error: unknown) => {
      if (
        !controller.signal.aborted &&
        !(error instanceof ApiError && error.status === 401)
      ) {
        setInitialError(
          error instanceof Error
            ? error.message
            : "Не удалось проверить доступность сервера.",
        );
      }
    };
    void Promise.all([
      request<Session>("/api/auth/me", options)
        .then((value) => {
          if (!controller.signal.aborted) setSession(value);
        })
        .catch(report),
      request<{ demo_enabled: boolean }>("/api/auth/options", options)
        .then((value) => {
          if (!controller.signal.aborted)
            setDemoAvailable(value.demo_enabled === true);
        })
        .catch(report),
    ]).finally(() => {
      if (!controller.signal.aborted) setChecked(true);
    });
    return () => controller.abort();
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
    <Login
      onSession={setSession}
      demoAvailable={demoAvailable}
      initialError={initialError}
    />
  );
}

export function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const [view, setView] = useState<(typeof nav)[number][0]>("overview");
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
  const hasPeriod = ["overview", "map", "fleet", "data"].includes(view);
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
      setMachines([]);
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
        if (err instanceof ApiError && err.status === 401) {
          onLogout();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось получить данные",
        );
      } finally {
        if (requestId !== loadRequest.current) return;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [dates, period, query, onLogout],
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
        if (err instanceof ApiError && err.status === 401) {
          onLogout();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось открыть машину",
        );
      });
    return () => controller.abort();
  }, [loadedPeriod, period, query, selected, validDates, onLogout]);

  useEffect(() => {
    if (view !== "quality") return;
    const controller = new AbortController();
    setQuality(null);
    request<Quality>("/api/quality", { signal: controller.signal })
      .then((payload) => {
        if (!controller.signal.aborted) setQuality(payload);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          onLogout();
          return;
        }
        setError(
          err instanceof Error ? err.message : "Не удалось загрузить журнал",
        );
      });
    return () => controller.abort();
  }, [view, refreshVersion, onLogout]);

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
      <a className="skip-link" href="#main-content">
        К содержимому
      </a>
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
          {nav.map(([id, label, Icon], index) => (
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
              <span className="nav-number" aria-hidden="true">
                0{index + 1}
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="privacy">
            <ShieldCheck size={16} />
            {session.demo
              ? "Стенд для проверки. Не вводите реальные данные предприятия."
              : "Не передавайте персональные данные в технических полях."}
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
      <main className="workspace" id="main-content" tabIndex={-1}>
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
              {session.demo
                ? "Знакомство с системой"
                : "Рабочая область организации"}
            </p>
            <h1>
              {view === "map"
                ? "Производственная карта"
                : nav.find((x) => x[0] === view)?.[1]}
            </h1>
          </div>
          {hasPeriod && (
            <div className="date-controls" aria-label="Период журнала, UTC">
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
              <span className="date-timezone">UTC</span>
            </div>
          )}
          <button
            className="refresh"
            type="button"
            onClick={() => void load(true)}
            disabled={
              refreshing || (hasPeriod && !validDates) || view === "docs"
            }
          >
            <RefreshCw size={17} className={refreshing ? "spin" : ""} />
            Обновить
          </button>
        </header>
        {session.demo && (
          <div className="demo-banner">
            <span className="demo-label">Учебный парк</span>
            <p>
              Вымышленные машины и записи. Даты сохранены; реальная техника не
              подключена.
            </p>
            <button type="button" onClick={() => setView("data")}>
              Что уже работает <ArrowUpRight size={15} />
            </button>
          </div>
        )}
        {!validDates && hasPeriod && (
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
        {loading || refreshing ? (
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
            onNavigate={setView}
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
  onNavigate: (view: (typeof nav)[number][0]) => void;
}) {
  if (view === "overview") return <Overview {...props} />;
  if (view === "fleet") return <FleetView {...props} />;
  if (view === "quality") return <QualityView quality={props.quality} />;
  if (view === "data")
    return <DataView dates={props.dates} validDates={props.validDates} />;
  if (view === "docs") return <Documents />;
  return <MapView {...props} />;
}

export function Overview({
  machines,
  fleet,
  onSelect,
  onNavigate,
}: {
  machines: Machine[];
  fleet: Fleet | null;
  onSelect: (id: string) => void;
  onNavigate: (view: (typeof nav)[number][0]) => void;
}) {
  const [search, setSearch] = useState("");
  const [ascending, setAscending] = useState(true);
  const filtered = machines
    .filter((machine) =>
      `${machine.name} ${machine.model ?? ""}`
        .toLocaleLowerCase("ru")
        .includes(search.toLocaleLowerCase("ru")),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru") * (ascending ? 1 : -1));
  const attention = machines.filter(
    (machine) =>
      machine.connection_status !== "fresh" ||
      machine.position?.status !== "fresh",
  );
  return (
    <div className="content-page overview-page">
      <div className="overview-lead">
        <p>
          Сначала общая картина.
          <br />
          <span>Затем — каждое наблюдение.</span>
        </p>
        <div className="fleet-census">
          <b>{fleet ? machines.length : "—"}</b>
          <span>
            машин в парке
            <br />
            {fleet
              ? `${machines.filter((m) => m.position).length} с координатами`
              : "сводка не получена"}
          </span>
        </div>
      </div>
      <div className="overview-grid">
        <section
          className="production-summary"
          aria-labelledby="production-summary-title"
        >
          <div className="section-heading">
            <h2 id="production-summary-title">Записано в журнале</h2>
            <span>За выбранный период</span>
          </div>
          {fleet?.totals.length ? (
            <div className="production-values">
              {fleet.totals.map((total) => (
                <div className="production-value" key={total.basis}>
                  <span>{basisName(total.basis)}</span>
                  <p>
                    <b>{volume(total.volume_m3)}</b> <span>м³</span>
                  </p>
                  <small>{recordCount(total.records)}</small>
                  <ProvenanceNotice total={total} />
                </div>
              ))}
            </div>
          ) : (
            <Empty>
              {fleet
                ? "За этот период нет записей выработки. Это не означает нулевую выработку машины."
                : "Сводка не получена. Обновите данные после восстановления связи."}
            </Empty>
          )}
          <div className="summary-footer">
            <p>
              Базы объёма считаются отдельно.
              <br />
              Суммы не подтверждают точность измерения.
            </p>
            <button
              type="button"
              className="text-button"
              onClick={() => onNavigate("fleet")}
            >
              Разобрать объём <ArrowUpRight size={17} />
            </button>
          </div>
        </section>
        <section className="attention-panel" aria-labelledby="attention-title">
          <div className="section-heading">
            <h2 id="attention-title">Проверить данные</h2>
            <Clock3 size={18} />
          </div>
          <p>Свежесть сообщений, не состояние техники.</p>
          {attention.length ? (
            attention.map((machine) => (
              <button
                className="attention-row"
                type="button"
                onClick={() => onSelect(machine.id)}
                key={machine.id}
              >
                <span>
                  <b>{machine.name}</b>
                  <small>
                    {!machine.last_seen
                      ? "Сообщения не поступали"
                      : machine.connection_status === "invalid"
                        ? "Сообщения требуют проверки"
                        : machine.connection_status !== "fresh"
                          ? "Последние сообщения устарели"
                          : !machine.position
                            ? "Координаты не поступали"
                            : "Координаты устарели или требуют проверки"}
                  </small>
                </span>
                <ArrowUpRight size={17} />
              </button>
            ))
          ) : (
            <p className="attention-empty">
              {machines.length
                ? "По всем машинам есть свежие сообщения и координаты. Исправность узлов этим не подтверждена."
                : "Машины ещё не добавлены в организацию."}
            </p>
          )}
          <button
            className="text-button"
            type="button"
            onClick={() => onNavigate("quality")}
          >
            Журнал приёма <ArrowUpRight size={17} />
          </button>
        </section>
      </div>
      <section className="table-card fleet-register">
        <div className="section-title">
          <div>
            <p className="eyebrow">От общего — к машине</p>
            <h2>Техника в парке</h2>
          </div>
          <label className="search-field">
            <Search size={17} />
            <input
              type="search"
              aria-label="Поиск машин"
              placeholder="Найти машину"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>
        <p className="table-note">
          Последние показания — независимо от периода. Выработка — за выбранные
          даты.
        </p>
        {filtered.length ? (
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Таблица машин"
          >
            <table>
              <caption className="sr-only">
                Машины, время последних сообщений и объём из журнала
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    aria-sort={ascending ? "ascending" : "descending"}
                  >
                    <button
                      type="button"
                      onClick={() => setAscending(!ascending)}
                    >
                      Машина {ascending ? "↑" : "↓"}
                    </button>
                  </th>
                  <th scope="col">Последнее сообщение</th>
                  <th scope="col">Топливо</th>
                  <th scope="col">Объём за период</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((machine) => {
                  const fuel = machine.metrics.find(
                    (metric) => metric.key === "fuel_level_pct",
                  );
                  const totals = fleet?.machines.find(
                    (entry) => entry.id === machine.id,
                  )?.totals;
                  return (
                    <tr key={machine.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="machine-link"
                          onClick={() => onSelect(machine.id)}
                        >
                          <span>
                            <b>{machine.name}</b>
                            <small>
                              {machine.model || "Модель не указана"}
                            </small>
                          </span>
                          <ArrowUpRight size={16} />
                        </button>
                      </th>
                      <td>
                        <span>{displayDate(machine.last_seen)}</span>
                        <StatusPill status={machine.connection_status} />
                      </td>
                      <td>
                        {fuel?.value != null ? (
                          <>
                            <b>
                              {metricValue(fuel)} {fuel.unit}
                            </b>
                            <StatusPill status={fuel.status} />
                          </>
                        ) : (
                          <span className="muted">Нет данных</span>
                        )}
                      </td>
                      <td>
                        {totals?.length ? (
                          totals.map((total) => (
                            <span className="table-volume" key={total.basis}>
                              <b>{volume(total.volume_m3)} м³</b>{" "}
                              {basisName(total.basis)}
                            </span>
                          ))
                        ) : (
                          <span className="muted">
                            {fleet ? "Нет записей" : "Не получен"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {search
              ? "Машины не найдены. Измените запрос или очистите поиск."
              : "В организации пока нет машин. Порядок подключения — в разделе «Передача данных»."}
          </Empty>
        )}
        <div className="table-footer">
          <span>
            Показано {filtered.length} из {machines.length}
          </span>
          <button
            className="text-button"
            type="button"
            onClick={() => onNavigate("map")}
          >
            Открыть карту <ArrowUpRight size={17} />
          </button>
        </div>
      </section>
    </div>
  );
}

function FitMachineBounds({
  machines,
  reset,
  selected,
}: {
  machines: Machine[];
  reset: number;
  selected: string | null;
}) {
  const map = useMap();
  const positions = machines
    .filter((machine) => machine.position)
    .map(
      (machine) =>
        [
          machine.position!.latitude,
          machine.position!.longitude,
        ] as L.LatLngTuple,
    );
  const coordinates = JSON.stringify(positions);
  useEffect(() => {
    const points = JSON.parse(coordinates) as L.LatLngTuple[];
    if (points.length)
      map.fitBounds(L.latLngBounds(points), {
        padding: [60, 60],
        maxZoom: 13,
        animate: false,
      });
  }, [map, coordinates, reset]);
  const selectedPosition = machines.find(
    (machine) => machine.id === selected,
  )?.position;
  const latitude = selectedPosition?.latitude;
  const longitude = selectedPosition?.longitude;
  useEffect(() => {
    if (latitude !== undefined && longitude !== undefined)
      map.panTo([latitude, longitude], { animate: false });
  }, [map, selected, latitude, longitude]);
  return null;
}

function MapView({
  machines,
  detail,
  selected,
  onSelect,
}: Omit<Parameters<typeof View>[0], "view" | "fleet" | "quality" | "dates">) {
  const [reset, setReset] = useState(0);
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
          <FitMachineBounds
            machines={machines}
            reset={reset}
            selected={selected}
          />
          <ZoomControl position="topright" />
          <GeoJSON
            data={naturalEarthRussiaRegion}
            style={{
              color: "var(--map-border)",
              weight: 1,
              fillColor: "var(--map-land)",
              fillOpacity: 0.72,
            }}
          />
          <div className="map-label map-label--north">Обзорная карта</div>
          <div className="map-grid-note">
            Без дорог и лесных кварталов. Только принятые координаты; внешние
            тайлы не загружаются.
          </div>
          {detail?.track && detail.track.length > 1 && (
            <Polyline
              positions={detail.track.map((p) => [p.latitude, p.longitude])}
              pathOptions={{
                color: "var(--map-border)",
                weight: 2,
                dashArray: "5 7",
              }}
            />
          )}
          {positioned.map((machine) => (
            <CircleMarker
              key={machine.id}
              center={[machine.position!.latitude, machine.position!.longitude]}
              radius={machine.id === selected ? 10 : 7}
              pathOptions={{
                color: "var(--ink)",
                fillColor:
                  machine.id === selected ? "var(--accent)" : "var(--surface)",
                fillOpacity: 1,
                weight: 3,
              }}
              eventHandlers={{ click: () => onSelect(machine.id) }}
            >
              {/* Leaflet reads permanent only when creating the tooltip. */}
              <Tooltip
                key={String(machine.id === selected)}
                direction="top"
                opacity={1}
                permanent={machine.id === selected}
              >
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
        <button
          className="map-reset"
          type="button"
          onClick={() => setReset((value) => value + 1)}
        >
          <LocateFixed size={16} />
          Весь парк
        </button>
        {!positioned.length && (
          <div className="map-empty">
            Координаты ещё не поступали. Положение машин на карте не показано.
          </div>
        )}
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
          <span>Карта или список</span>
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
                aria-pressed={machine.id === selected}
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
  const primaryKeys = [
    "fuel_level_pct",
    "engine_rpm",
    "engine_oil_pressure_kpa",
    "hydraulic_oil_temperature_c",
  ];
  const primary = detail.metrics.filter((metric) =>
    primaryKeys.includes(metric.key),
  );
  const other = detail.metrics.filter(
    (metric) => !primaryKeys.includes(metric.key),
  );
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
        {primary.map((metric) => (
          <MetricReading metric={metric} key={metric.key} />
        ))}
      </div>
      {other.length > 0 && (
        <details className="other-metrics">
          <summary>
            Остальные показатели <span>{other.length}</span>
          </summary>
          <div className="metrics metrics--additional">
            {other.map((metric) => (
              <MetricReading metric={metric} key={metric.key} />
            ))}
          </div>
        </details>
      )}
      <p className="norm-note">
        Статус показывает свежесть наблюдения, не исправность узла. Заводские
        нормы не подтверждены.
      </p>
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
                  {basisName(total.basis)} · {recordCount(total.records)}
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

function MetricReading({ metric }: { metric: Metric }) {
  return (
    <div className="metric">
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
            ? displayDate(metric.observed_at)
            : "Не поступало"}
        </small>
      </footer>
    </div>
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
  const warnings = [...new Set(total.warnings ?? [])];
  if (!unknown && !warnings.length) return null;
  return (
    <div className="provenance-warning">
      {unknown && (
        <p>
          <AlertTriangle size={14} />
          Источник, метод или версия методики указаны не полностью. Требуется
          сверка.
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning}>
          <AlertTriangle size={14} />
          {warning}
        </p>
      ))}
    </div>
  );
}

export function FleetView({
  fleet,
  machines,
  onSelect,
}: {
  fleet: Fleet | null;
  machines: Machine[];
  onSelect?: (id: string) => void;
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
                  <span>{recordCount(total.records)} журнала</span>
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
                  {machines.length} машин · {recordCount(fleet.record_count)}
                </h2>
              </div>
              <a
                className="text-button"
                href={`/api/exports/ledger.csv?start=${encodeURIComponent(fleet.period.start)}&end=${encodeURIComponent(fleet.period.end)}`}
              >
                <Download size={17} />
                Журнал CSV
              </a>
            </div>
            <div
              className="table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Расшифровка объёма по машинам"
            >
              <table>
                <caption className="sr-only">
                  Выработка и изменение счётчика наработки за выбранный период
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Машина</th>
                    <th scope="col">Выработка</th>
                    <th scope="col">Изменение счётчика</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.machines.map((machine) => (
                    <tr key={machine.id}>
                      <th scope="row">
                        {onSelect ? (
                          <button
                            className="machine-link"
                            type="button"
                            onClick={() => onSelect(machine.id)}
                          >
                            <b>{machine.name}</b>
                            <ArrowUpRight size={16} />
                          </button>
                        ) : (
                          machine.name
                        )}
                      </th>
                      <td>
                        {machine.totals.length
                          ? machine.totals.map((x) => (
                              <div key={x.basis}>
                                <span className="table-volume">
                                  <b>{volume(x.volume_m3)} м³</b>{" "}
                                  {basisName(x.basis)}
                                </span>
                                <ProvenanceNotice total={x} />
                              </div>
                            ))
                          : "Нет записей"}
                      </td>
                      <td>
                        {machine.engine_hours === null
                          ? "недоступны — недостаточно наблюдений или сброс счётчика"
                          : `${machine.engine_hours.toLocaleString("ru-RU")} ч между наблюдениями`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Аудит доставки"
              >
                <table>
                  <caption className="sr-only">
                    Последние исходы приёма пакетов
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Получено</th>
                      <th scope="col">Статус</th>
                      <th scope="col">Причина</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quality.recent.map((item, index) => (
                      <tr key={`${item.received_at}-${index}`}>
                        <td>{displayDate(item.received_at)}</td>
                        <td>
                          {{
                            accepted: "Принято",
                            duplicate: "Повтор",
                            duplicates: "Повтор",
                            rejected: "Отклонено",
                          }[item.status] ?? item.status}
                        </td>
                        <td>{item.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
          <h2>Откуда берутся данные</h2>
        </div>
      </section>
      <div className="readiness-grid">
        <section>
          <h3>Реализовано на стенде</h3>
          <p>
            API принимает нормализованные события, SQLite хранит записи,
            интерфейс показывает показатели и раздельные суммы. Локальная
            очередь повторяет доставку. Корректность проверяется синтетическими
            тестами.
          </p>
        </section>
        <section>
          <h3>Ещё не подключено</h3>
          <p>
            Штатный компьютер реального харвестера, OEM/CAN/StanForD-адаптер и
            конфигурация 1С заказчика. Для них нужны доступ, эталонные файлы и
            отдельная проверка на технике.
          </p>
        </section>
      </div>
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
    "method_version": "synthetic-example-v1"
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
          Источники, методики расчёта и программа полевых испытаний. Документы
          отделяют подтверждённые сведения от проектных решений и непроверенных
          предположений.
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
