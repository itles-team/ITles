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
  Polyline: () => null,
  CircleMarker: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));
vi.mock("leaflet", () => ({ default: {} }));

import { App, DataView, FleetView, Workspace } from "./main";

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

  it("logs in through the actual form", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/me")
        return json({ detail: "Не авторизован" }, 401);
      if (url === "/api/auth/login") return json(session);
      if (url === "/api/machines") return json(machines);
      if (url.startsWith("/api/fleet?")) return json(fleet);
      if (url.startsWith("/api/machines/")) return json(detail);
      return json({});
    });

    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Открыть свой парк" });
    await user.type(screen.getByLabelText("Код организации"), "forest-1");
    await user.type(screen.getByLabelText("Пароль"), "correct-horse-battery");
    await user.click(
      screen.getByRole("button", { name: /Войти в организацию/i }),
    );

    expect(
      await screen.findByRole("heading", { name: "Производственная карта" }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
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
    await screen.findByRole("heading", { name: "Харвестер 01" });
    await userEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Сервер не подтвердил выход",
    );
    expect(onLogout).not.toHaveBeenCalled();
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
    expect(screen.getByText(/"method_version": "hpr-4\.2"/)).toBeVisible();
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
