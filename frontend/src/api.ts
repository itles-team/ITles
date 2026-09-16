export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "Нет связи с сервером. Проверьте соединение и повторите попытку.",
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(
      response.status,
      "Сервер не вернул данные API. Проверьте запуск Python-приложения: одного статического сайта недостаточно.",
    );
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const detail =
      body && typeof body === "object" && "detail" in body ? body.detail : null;
    let message =
      "Не удалось получить данные. Повторите запрос; если ошибка останется, сообщите администратору.";
    if (response.status === 401) {
      message =
        url === "/api/auth/login"
          ? "Не удалось войти. Проверьте код организации и пароль. Доступ выдаёт администратор; ввод нового кода не создаёт учётную запись."
          : "Сеанс завершён. Войдите снова, чтобы получить данные организации.";
    } else if (response.status === 429) {
      message =
        detail === "demo session capacity reached; try again later"
          ? "Учебный парк достиг лимита одновременных сеансов. Попробуйте позже: неиспользуемые сеансы истекают в течение часа."
          : "Слишком много попыток. Подождите перед повторным входом.";
    } else if (response.status === 404 && url === "/api/auth/demo") {
      message =
        "Учебный парк отключён на этом сервере. Используйте выданный доступ организации.";
    } else if (response.status === 422) {
      message =
        url === "/api/auth/login"
          ? "Проверьте код организации и пароль: сервер не принял формат данных."
          : "Проверьте выбранный период: сервер не принял параметры запроса.";
    } else if (response.status === 403) {
      message =
        "Сервер отклонил запрос. Проверьте адрес сайта и права доступа у администратора.";
    }
    throw new ApiError(response.status, message);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(
      response.status,
      "Сервер вернул повреждённые данные. Повторите запрос.",
    );
  }
}
