/**
 * Google Tasks API v1 client.
 *
 * Owns the access-token lifecycle: it holds the stored refresh token, keeps a
 * short-lived access token in memory, and transparently refreshes once when
 * Google answers 401. Callers never see a token.
 */
import type { Env } from "../env.js";
import { ToolExecutionError } from "../errors.js";
import { GoogleAuthError, refreshGoogleAccessToken } from "../auth/google.js";
import { loadGoogleRefreshToken } from "../store.js";

const API_BASE = "https://tasks.googleapis.com/tasks/v1";

/** Refresh this many seconds before Google's stated expiry. */
const EXPIRY_SKEW_SECONDS = 60;

/** Hard ceiling on how much we will pull for one list_tasks call. */
const MAX_PAGES = 3;
const PAGE_SIZE = 100;

export interface TaskList {
  id: string;
  title: string;
  updated?: string;
}

export interface Task {
  id: string;
  title: string;
  notes?: string;
  due?: string;
  status: "needsAction" | "completed";
  completed?: string;
  updated?: string;
  parent?: string;
}

export interface ListTasksOptions {
  tasklistId: string;
  showCompleted: boolean;
  dueMin?: string;
  dueMax?: string;
}

export interface TaskPatch {
  title?: string;
  notes?: string;
  due?: string;
  status?: "needsAction" | "completed";
}

/**
 * Access token cache, shared across requests handled by the same isolate.
 *
 * This is a single-user server, so one slot is enough and there is no risk of
 * handing one user's token to another. It saves a token round-trip to Google
 * on most calls.
 */
let cachedAccessToken: { value: string; expiresAtSeconds: number } | null = null;

/** Test seam: drop the cached token. */
export function resetAccessTokenCache(): void {
  cachedAccessToken = null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface GoogleErrorBody {
  error?: { message?: unknown; status?: unknown };
}

export class TasksClient {
  constructor(private readonly env: Env) {}

  private async accessToken(forceRefresh: boolean): Promise<string> {
    if (
      !forceRefresh &&
      cachedAccessToken !== null &&
      cachedAccessToken.expiresAtSeconds > nowSeconds()
    ) {
      return cachedAccessToken.value;
    }

    const refreshToken = await loadGoogleRefreshToken(this.env);
    if (refreshToken === null) {
      throw new GoogleAuthError(
        "This server is not connected to a Google account yet. Reconnect the connector.",
        true,
      );
    }

    const tokens = await refreshGoogleAccessToken(this.env, refreshToken);
    cachedAccessToken = {
      value: tokens.accessToken,
      expiresAtSeconds: nowSeconds() + tokens.expiresInSeconds - EXPIRY_SKEW_SECONDS,
    };
    return tokens.accessToken;
  }

  /**
   * One API call, with a single transparent retry after refreshing the access
   * token. Exactly one retry: if Google still says 401 the grant itself is
   * gone and looping would only hammer the token endpoint.
   */
  private async request<T>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    let response = await this.send(method, path, options, false);
    if (response.status === 401) {
      response = await this.send(method, path, options, true);
    }

    if (response.status === 401) {
      cachedAccessToken = null;
      throw new GoogleAuthError(
        "Google rejected the stored credentials. Reconnect the connector to grant access again.",
        true,
      );
    }
    if (!response.ok) throw await describeFailure(response);

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async send(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown },
    forceRefresh: boolean,
  ): Promise<Response> {
    const token = await this.accessToken(forceRefresh);
    const url = new URL(API_BASE + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    return fetch(url.toString(), body === undefined ? { method, headers } : { method, headers, body });
  }

  async listTaskLists(): Promise<TaskList[]> {
    const result = await this.request<{ items?: TaskList[] }>("GET", "/users/@me/lists", {
      query: { maxResults: String(PAGE_SIZE) },
    });
    return result.items ?? [];
  }

  /** Returns the tasks plus whether the page cap cut the result short. */
  async listTasks(options: ListTasksOptions): Promise<{ tasks: Task[]; truncated: boolean }> {
    const tasks: Task[] = [];
    let pageToken: string | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: Record<string, string> = {
        maxResults: String(PAGE_SIZE),
        showCompleted: String(options.showCompleted),
        // Completed tasks are hidden by default; showCompleted alone is not
        // enough to make them appear.
        showHidden: String(options.showCompleted),
      };
      if (options.dueMin !== undefined) query["dueMin"] = options.dueMin;
      if (options.dueMax !== undefined) query["dueMax"] = options.dueMax;
      if (pageToken !== undefined) query["pageToken"] = pageToken;

      const result = await this.request<{ items?: Task[]; nextPageToken?: string }>(
        "GET",
        `/lists/${encodeURIComponent(options.tasklistId)}/tasks`,
        { query },
      );
      tasks.push(...(result.items ?? []));

      if (result.nextPageToken === undefined) return { tasks, truncated };
      pageToken = result.nextPageToken;
      truncated = true;
    }
    return { tasks, truncated };
  }

  async createTask(tasklistId: string, task: TaskPatch & { title: string }): Promise<Task> {
    return this.request<Task>("POST", `/lists/${encodeURIComponent(tasklistId)}/tasks`, {
      body: task,
    });
  }

  async patchTask(tasklistId: string, taskId: string, patch: TaskPatch): Promise<Task> {
    return this.request<Task>(
      "PATCH",
      `/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
      { body: patch },
    );
  }

  async deleteTask(tasklistId: string, taskId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`,
    );
  }
}

/**
 * Turn a Google error response into something the model can act on, without
 * echoing anything we did not already send.
 */
async function describeFailure(response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as GoogleErrorBody;
    if (typeof body.error?.message === "string") {
      detail = ` ${body.error.message.slice(0, 200)}`;
    }
  } catch {
    // Non-JSON error body; the status alone will have to do.
  }

  switch (response.status) {
    case 403:
      return new ToolExecutionError(
        `Google denied this request. Check that the Google Tasks API is enabled for the project.${detail}`,
      );
    case 404:
      return new ToolExecutionError(
        `Not found — the task list or task id does not exist.${detail}`,
      );
    case 400:
      return new ToolExecutionError(`Google rejected the request as invalid.${detail}`);
    case 429:
      return new ToolExecutionError("Google's rate limit was hit. Try again in a moment.");
    default:
      return new ToolExecutionError(
        `The Google Tasks API returned an unexpected status (${response.status}).`,
      );
  }
}
