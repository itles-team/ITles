import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  GeoJSON: () => null,
  ZoomControl: () => null,
  useMap: () => ({ fitBounds: () => undefined, panTo: () => undefined }),
  Polyline: () => null,
  CircleMarker: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("leaflet", () => ({
  default: { latLngBounds: (points: unknown) => points },
}));

import { App, DataView, FleetView, Overview, Workspace } from "./main";

const session = {
  organization: { id: "demo", name: "Учебная организация" },
  demo: false,
};
const machines = {
  machines: [
    {
      id: "harvester-01",
      name: "Харвестер 01",
      model: null,
      head: null,
      computer: null,
      connection_status: "fresh",
      metrics: [],
      position: null,
      last_seen: null,
    },
  ],
};
const fleet = {
  period: { start: "2026-01-01", end: "2026-01-14" },
  totals: [],
  machines: [],
  record_count: 0,
};
const detail = {
  ...machines.machines[0],
  production: [],
  totals: [],
  track: [],
  engine_hours: null,
};

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("production map frontend", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the demo first, while keeping organization login available", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me")
        return json({ detail: "Не авторизован" }, 401);
      if (url === "/api/auth/options") return json({ demo_enabled: true });
      if (url === "/api/auth/demo") return json({ ...session, demo: true });
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole("heading", {
      name: /Посмотрите, как устроен парк/i,
    });
    expect(
      screen.getByRole("button", { name: "Открыть учебный парк" }),
    ).toBeVisible();
    expect(
      screen.getByRole("form", { name: "Вход в организацию", hidden: true }),
    ).not.toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Уже есть доступ организации?" }),
    );
    expect(
      screen.getByRole("form", { name: "Вход в организацию" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Открыть учебный парк" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Обзор парка" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/demo",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses organization login directly when the server disables the demo", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me")
        return json({ detail: "Не авторизован" }, 401);
      if (url === "/api/auth/options") return json({ demo_enabled: false });
      if (url === "/api/auth/login") return json(session);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "Вход в организацию" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Открыть учебный парк" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("form", { name: "Вход в организацию" }),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Код организации"), "forest-1");
    await user.type(screen.getByLabelText("Пароль"), "correct-horse-battery");
    await user.click(
      screen.getByRole("button", { name: "Войти в организацию" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Обзор парка" }),
    ).toBeVisible();
  });

  it("restores an existing organization session regardless of demo availability", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me") return json(session);
      if (url === "/api/auth/options") return json({ demo_enabled: true });
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Обзор парка" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /Посмотрите, как устроен парк/i }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/options",
      expect.anything(),
    );
  });

  it("lets an organization user inspect the password before submitting it", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me")
        return json({ detail: "Не авторизован" }, 401);
      if (url === "/api/auth/options") return json({ demo_enabled: true });
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole("heading", {
      name: /Посмотрите, как устроен парк/i,
    });
    await user.click(
      screen.getByRole("button", { name: "Уже есть доступ организации?" }),
    );

    const password = screen.getByLabelText("Пароль");
    const reveal = screen.getByRole("button", { name: "Показать пароль" });
    expect(password).toHaveAttribute("type", "password");
    expect(reveal).toHaveAttribute("aria-pressed", "false");

    await user.click(reveal);
    expect(password).toHaveAttribute("type", "text");
    expect(
      screen.getByRole("button", { name: "Скрыть пароль" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("uses the fixed demo data period instead of the browser's current date", async () => {
    const demoSession = {
      ...session,
      demo: true,
      data_period: { start: "2024-02-01", end: "2024-02-29" },
    };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<Workspace session={demoSession} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));

    expect(screen.getByLabelText("Дата начала периода")).toHaveValue(
      "2024-02-01",
    );
    expect(screen.getByLabelText("Дата окончания периода")).toHaveValue(
      "2024-02-29",
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/fleet?start=2024-02-01&end=2024-02-29",
        expect.anything(),
      ),
    );
  });

  it("refreshes packet quality outcomes when refresh is requested", async () => {
    let qualityCalls = 0;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/quality") {
        qualityCalls += 1;
        return json({
          counts: { accepted: qualityCalls, duplicates: 0, rejected: 0 },
          recent: [],
          limitations: [],
        });
      }
      return json({});
    });
    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    await screen.findByRole("heading", { name: "Харвестер 01" });
    await userEvent.click(
      screen.getByRole("button", { name: "Качество данных" }),
    );
    await waitFor(() => expect(qualityCalls).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: /Обновить/ }));
    await waitFor(() => expect(qualityCalls).toBe(2));
  });

  it("does not pretend a session ended when logout failed", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/auth/logout")
        return Promise.reject(new TypeError("offline"));
      return json({});
    });
    render(<Workspace session={session} onLogout={onLogout} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    await screen.findByRole("heading", { name: "Харвестер 01" });
    await userEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Сервер не подтвердил выход",
    );
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("returns to login when an expired session rejects a workspace request", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines")
        return json({ detail: "Не авторизован" }, 401);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("returns to login when an expired session rejects a machine detail", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/"))
        return json({ detail: "Не авторизован" }, 401);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("returns to login when an expired session rejects the quality audit", async () => {
    const onLogout = vi.fn();
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      if (url === "/api/quality")
        return json({ detail: "Не авторизован" }, 401);
      return json({});
    });

    render(<Workspace session={session} onLogout={onLogout} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Качество данных" }));

    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
  });

  it("does not render a stale machine detail after the period changes", async () => {
    let resolveOldDetail!: (value: Response | PromiseLike<Response>) => void;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    let detailCalls = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        detailCalls += 1;
        return detailCalls === 1
          ? oldDetail
          : json({ ...detail, name: "Новая карточка" });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    await waitFor(() => expect(detailCalls).toBe(1));

    fireEvent.change(screen.getByLabelText("Дата начала периода"), {
      target: { value: "2026-01-01" },
    });
    await waitFor(() => expect(detailCalls).toBe(2));
    expect(
      await screen.findByRole("heading", { name: "Новая карточка" }),
    ).toBeVisible();

    json({ ...detail, name: "Старая карточка" }).then(resolveOldDetail);
    await waitFor(() =>
      expect(screen.queryByText("Старая карточка")).not.toBeInTheDocument(),
    );
  });

  it("does not render a stale detail after selecting another machine", async () => {
    let resolveFirstDetail!: (value: Response | PromiseLike<Response>) => void;
    const firstDetail = new Promise<Response>((resolve) => {
      resolveFirstDetail = resolve;
    });
    const twoMachines = {
      machines: [
        ...machines.machines,
        { ...machines.machines[0], id: "harvester-02", name: "Харвестер 02" },
      ],
    };
    let detailCalls = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(twoMachines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        detailCalls += 1;
        return detailCalls === 1
          ? firstDetail
          : json({ ...detail, id: "harvester-02", name: "Вторая карточка" });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    await waitFor(() => expect(detailCalls).toBe(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Харвестер 02/i }));
    expect(
      await screen.findByRole("heading", { name: "Вторая карточка" }),
    ).toBeVisible();

    json({ ...detail, name: "Первая устаревшая карточка" }).then(
      resolveFirstDetail,
    );
    await waitFor(() =>
      expect(
        screen.queryByText("Первая устаревшая карточка"),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not render a stale detail after a manual refresh", async () => {
    let resolveOldDetail!: (value: Response | PromiseLike<Response>) => void;
    const oldDetail = new Promise<Response>((resolve) => {
      resolveOldDetail = resolve;
    });
    let detailCalls = 0;
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        detailCalls += 1;
        return detailCalls === 1
          ? oldDetail
          : json({ ...detail, name: "Карточка после обновления" });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    await waitFor(() => expect(detailCalls).toBe(1));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Обновить/i }));
    expect(
      await screen.findByRole("heading", { name: "Карточка после обновления" }),
    ).toBeVisible();

    json({ ...detail, name: "Устаревшая карточка" }).then(resolveOldDetail);
    await waitFor(() =>
      expect(screen.queryByText("Устаревшая карточка")).not.toBeInTheDocument(),
    );
  });

  it("does not make a period request when a date is empty", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    await screen.findByText("Харвестер 01");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const callsBeforeEmptyDate = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Дата начала периода"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Укажите обе даты периода",
      ),
    );
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeEmptyDate);
  });

  it("warns when the source or method provenance is unknown", () => {
    render(
      <FleetView
        machines={[]}
        fleet={{
          ...fleet,
          totals: [
            {
              basis: "under_bark",
              volume_m3: "12.5",
              records: 1,
              provenance: {
                sources: ["unknown"],
                methods: ["manual_ledger"],
                method_versions: ["unknown"],
                calibration_refs: [],
              },
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText(/Источник, метод или версия методики/i),
    ).toBeVisible();
    expect(screen.getByText("Изменение счётчика")).toBeVisible();
  });

  it("warns when known methods or method versions are mixed in one total", () => {
    const mixedMethodWarning =
      "В итоге смешаны методы или версии расчёта. Сумма арифметическая; сопоставимость методик не подтверждена.";
    render(
      <FleetView
        machines={[]}
        fleet={{
          ...fleet,
          totals: [
            {
              basis: "under_bark",
              volume_m3: "12.5",
              records: 2,
              provenance: {
                sources: ["onboard_measurement"],
                methods: ["harvester_onboard", "merchantable_log"],
                method_versions: ["hpr-4.2", "hpr-4.3"],
                calibration_refs: [],
              },
              warnings: [mixedMethodWarning, mixedMethodWarning],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(mixedMethodWarning)).toBeVisible();
    expect(screen.getAllByText(mixedMethodWarning)).toHaveLength(1);
    expect(
      screen.queryByText(
        /Источник, метод или версия методики указаны не полностью/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders a mixed-source warning supplied by the API", () => {
    const mixedSourceWarning =
      "В итоге смешаны источники. Требуется сверка, чтобы исключить повторный учёт одной выработки.";
    render(
      <FleetView
        machines={[]}
        fleet={{
          ...fleet,
          totals: [
            {
              basis: "under_bark",
              volume_m3: "12.5",
              records: 2,
              provenance: {
                sources: ["onboard_measurement", "operator_export"],
                methods: ["harvester_onboard"],
                method_versions: ["hpr-4.2"],
                calibration_refs: [],
              },
              warnings: [mixedSourceWarning],
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(mixedSourceWarning)).toBeVisible();
    expect(
      screen.queryByText(
        /Источник, метод или версия методики указаны не полностью/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps a stale GPS observation in the attention list despite fresh connection", async () => {
    const onSelect = vi.fn();
    render(
      <Overview
        fleet={fleet}
        onSelect={onSelect}
        onNavigate={vi.fn()}
        machines={[
          {
            ...machines.machines[0],
            connection_status: "fresh" as const,
            last_seen: "2026-01-14T08:30:00Z",
            position: {
              latitude: 61.1,
              longitude: 73.4,
              observed_at: "2026-01-13T08:30:00Z",
              status: "stale",
            },
          },
        ]}
      />,
    );

    const attention = screen.getByRole("button", {
      name: /Харвестер 01.*Координаты устарели/i,
    });
    expect(attention).toHaveTextContent(
      "Координаты устарели или требуют проверки",
    );
    await userEvent.setup().click(attention);
    expect(onSelect).toHaveBeenCalledWith("harvester-01");
  });

  it("filters and sorts machines without confusing stored zeroes with missing data", async () => {
    const overviewMachines = [
      {
        ...machines.machines[0],
        connection_status: "fresh" as const,
        id: "alpha",
        name: "Альфа",
        model: "A-1",
        last_seen: "2026-01-14T08:30:00Z",
        metrics: [
          {
            key: "fuel_level_pct",
            label: "Уровень топлива",
            value: 0,
            unit: "%",
            observed_at: "2026-01-14T08:30:00Z",
            status: "fresh" as const,
            source: "onboard_measurement",
            explanation: "Тестовое значение.",
            norm: null,
          },
        ],
      },
      {
        ...machines.machines[0],
        connection_status: "fresh" as const,
        id: "beta",
        name: "Бета",
        model: null,
        last_seen: null,
        metrics: [
          {
            key: "fuel_level_pct",
            label: "Уровень топлива",
            value: null,
            unit: "%",
            observed_at: null,
            status: "missing" as const,
            source: "onboard_measurement",
            explanation: "Тестовое значение.",
            norm: null,
          },
        ],
      },
    ];
    render(
      <Overview
        machines={overviewMachines}
        fleet={{
          ...fleet,
          machines: [
            {
              id: "alpha",
              name: "Альфа",
              engine_hours: 0,
              totals: [{ basis: "under_bark", volume_m3: "0", records: 0 }],
            },
            { id: "beta", name: "Бета", engine_hours: null, totals: [] },
          ],
        }}
        onSelect={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const table = screen.getByRole("region", { name: "Таблица машин" });

    expect(screen.getByRole("row", { name: /Альфа/ })).toHaveTextContent("0 %");
    expect(screen.getByRole("row", { name: /Альфа/ })).toHaveTextContent(
      "0 м³",
    );
    expect(screen.getByRole("row", { name: /Бета/ })).toHaveTextContent(
      "Нет данных",
    );
    expect(screen.getByRole("row", { name: /Бета/ })).toHaveTextContent(
      "Нет записей",
    );

    const rowsBeforeSort = Array.from(table.querySelectorAll("tbody tr"));
    expect(rowsBeforeSort.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Альфа"),
      expect.stringContaining("Бета"),
    ]);
    await user.click(screen.getByRole("button", { name: /Машина ↑/ }));
    expect(table.querySelectorAll("tbody tr")[0]).toHaveTextContent("Бета");

    await user.type(screen.getByLabelText("Поиск машин"), "альфа");
    expect(screen.getByRole("row", { name: /Альфа/ })).toBeVisible();
    expect(screen.queryByRole("row", { name: /Бета/ })).not.toBeInTheDocument();
    expect(screen.getByText("Показано 1 из 2")).toBeVisible();
  });

  it("shows the real outbox commands and a schema-valid production example", () => {
    render(
      <DataView
        dates={{ start: "2026-01-01", end: "2026-01-14" }}
        validDates
      />,
    );

    expect(
      screen.getByText(/python -m edge\.outbox enqueue normalized\.json/),
    ).toBeVisible();
    expect(screen.getByText(/export ITLES_DEVICE_TOKEN=/)).toBeVisible();
    expect(screen.getByText(/python -m edge\.outbox flush/)).toBeVisible();
    expect(screen.getByText(/--url https:\/\/ваш-домен/)).toBeVisible();
    expect(
      screen.getByText(/"method_version": "synthetic-example-v1"/),
    ).toBeVisible();
    expect(screen.queryByText(/--token/)).not.toBeInTheDocument();
  });

  it("keeps focus in a metric dialog and restores it after Escape", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) {
        return json({
          ...detail,
          metrics: [
            {
              key: "fuel_level_pct",
              label: "Уровень топлива",
              value: 62.5,
              unit: "%",
              observed_at: "2026-01-14T08:30:00Z",
              status: "fresh",
              source: "onboard_measurement",
              explanation: "Значение поступает из нормализованного события.",
              norm: null,
            },
          ],
        });
      }
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Карта производства" }));
    const trigger = await screen.findByRole("button", {
      name: "Уровень топлива: открыть пояснение",
    });
    await userEvent.setup().click(trigger);

    expect(
      screen.getByRole("dialog", { name: "Уровень топлива" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Закрыть пояснение" }),
    ).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("makes the closed mobile navigation inert and returns focus on Escape", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<Workspace session={session} onLogout={vi.fn()} />);
    const menu = screen.getByRole("button", { name: "Открыть меню" });
    const navigation = document.getElementById("main-navigation");
    expect(navigation).toHaveAttribute("inert");

    await userEvent.setup().click(menu);
    const closeNavigation = navigation?.querySelector(".close-nav");
    expect(closeNavigation).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(menu).toHaveAttribute("aria-expanded", "false"));
    expect(menu).toHaveFocus();
  });
});
