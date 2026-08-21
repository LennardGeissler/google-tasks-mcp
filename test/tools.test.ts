import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolExecutionError } from "../src/errors.js";
import { callTool, type ToolContext } from "../src/mcp/handlers.js";
import { TOOLS } from "../src/mcp/tools.js";
import { resetAccessTokenCache } from "../src/google/tasks-client.js";
import { saveGoogleRefreshToken } from "../src/store.js";
import { installFetch, jsonResponse, testEnv, type RecordedCall } from "./helpers.js";

interface TasksBackend {
  lists?: unknown[];
  tasks?: unknown[];
  /** Force every Tasks API call to this status. */
  status?: number;
  /** Keep handing out a nextPageToken so pagination hits its cap. */
  endlessPages?: boolean;
}

let sessionCounter = 0;

beforeEach(() => {
  resetAccessTokenCache();
  sessionCounter += 1;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup(backend: TasksBackend = {}) {
  const env = testEnv();
  await saveGoogleRefreshToken(env, "stored-refresh-token");

  const fetchMock = installFetch((call: RecordedCall) => {
    if (call.url.includes("oauth2.googleapis.com/token")) {
      return jsonResponse({ access_token: "access-token", expires_in: 3599 });
    }
    if (backend.status !== undefined && backend.status !== 200) {
      return jsonResponse({ error: { message: "backend says no" } }, backend.status);
    }

    const url = new URL(call.url);
    if (url.pathname.endsWith("/users/@me/lists")) {
      return jsonResponse({ items: backend.lists ?? [] });
    }
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    if (call.method === "POST" || call.method === "PATCH") {
      const sent = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
      return jsonResponse({ id: "task-1", status: "needsAction", ...sent });
    }
    return jsonResponse({
      items: backend.tasks ?? [],
      ...(backend.endlessPages === true ? { nextPageToken: "next" } : {}),
    });
  });

  const context: ToolContext = { env, sessionId: `session-${sessionCounter}` };
  return { env, context, fetchMock };
}

/** The structuredContent of a successful call. */
async function call(
  context: ToolContext,
  name: string,
  args: unknown = {},
): Promise<Record<string, unknown>> {
  const result = await callTool(context, name, args);
  return result.structuredContent as Record<string, unknown>;
}

function tasksApiCall(fetchMock: { calls: RecordedCall[] }): RecordedCall {
  const call = fetchMock.calls.find((entry) => entry.url.includes("tasks.googleapis.com"));
  if (call === undefined) throw new Error("no Tasks API call was made");
  return call;
}

describe("tool definitions", () => {
  it("annotates the read-only tools and the destructive one", () => {
    const byName = new Map(TOOLS.map((tool) => [tool.name, tool.annotations]));
    expect(byName.get("list_tasklists")?.readOnlyHint).toBe(true);
    expect(byName.get("list_tasks")?.readOnlyHint).toBe(true);
    expect(byName.get("delete_task")?.destructiveHint).toBe(true);
    expect(byName.get("delete_task")?.readOnlyHint).toBe(false);
    for (const tool of TOOLS) {
      if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it("exposes exactly the six tools", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "list_tasklists",
      "list_tasks",
      "create_task",
      "update_task",
      "complete_task",
      "delete_task",
    ]);
  });
});

describe("list_tasklists", () => {
  it("returns id and title only", async () => {
    const { context } = await setup({
      lists: [{ id: "l1", title: "Inbox", updated: "2026-01-01T00:00:00Z", etag: "x" }],
    });
    const output = await call(context, "list_tasklists");
    expect(output["tasklists"]).toEqual([{ id: "l1", title: "Inbox" }]);
  });
});

describe("list_tasks", () => {
  it("hides completed tasks by default", async () => {
    const { context, fetchMock } = await setup();
    await call(context, "list_tasks");

    const url = new URL(tasksApiCall(fetchMock).url);
    expect(url.pathname).toContain("/lists/%40default/tasks");
    expect(url.searchParams.get("showCompleted")).toBe("false");
    expect(url.searchParams.get("showHidden")).toBe("false");
  });

  it("asks for hidden tasks too when show_completed is set", async () => {
    const { context, fetchMock } = await setup();
    await call(context, "list_tasks", { show_completed: true });

    const url = new URL(tasksApiCall(fetchMock).url);
    // showCompleted alone does not surface completed tasks in this API.
    expect(url.searchParams.get("showCompleted")).toBe("true");
    expect(url.searchParams.get("showHidden")).toBe("true");
  });

  it("sends the due range as inclusive day bounds", async () => {
    const { context, fetchMock } = await setup();
    await call(context, "list_tasks", { due_after: "2026-03-01", due_before: "2026-03-31" });

    const url = new URL(tasksApiCall(fetchMock).url);
    expect(url.searchParams.get("dueMin")).toBe("2026-03-01T00:00:00.000Z");
    expect(url.searchParams.get("dueMax")).toBe("2026-03-31T23:59:59.999Z");
  });

  it("re-filters the due range locally, because Google's filter is unreliable", async () => {
    const { context } = await setup({
      tasks: [
        { id: "a", title: "in range", status: "needsAction", due: "2026-03-10T00:00:00.000Z" },
        { id: "b", title: "too late", status: "needsAction", due: "2026-04-10T00:00:00.000Z" },
        { id: "c", title: "no due date", status: "needsAction" },
      ],
    });

    const output = await call(context, "list_tasks", {
      due_after: "2026-03-01",
      due_before: "2026-03-31",
    });

    expect(output["count"]).toBe(1);
    expect(output["tasks"]).toEqual([
      { id: "a", title: "in range", status: "needsAction", due: "2026-03-10" },
    ]);
  });

  it("keeps tasks without a due date when no range is given", async () => {
    const { context } = await setup({
      tasks: [{ id: "c", title: "no due date", status: "needsAction" }],
    });
    const output = await call(context, "list_tasks");
    expect(output["count"]).toBe(1);
  });

  it("reports truncation instead of paging forever", async () => {
    const { context, fetchMock } = await setup({
      tasks: [{ id: "a", title: "t", status: "needsAction" }],
      endlessPages: true,
    });
    const output = await call(context, "list_tasks");

    expect(output["truncated"]).toBe(true);
    expect(fetchMock.calls.filter((c) => c.url.includes("/tasks?"))).toHaveLength(3);
  });

  it("rejects a malformed or impossible date before calling Google", async () => {
    const { context, fetchMock } = await setup();
    await expect(call(context, "list_tasks", { due_after: "01.03.2026" })).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
    await expect(call(context, "list_tasks", { due_after: "2026-02-30" })).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
    expect(fetchMock.calls.filter((c) => c.url.includes("tasks.googleapis.com"))).toHaveLength(0);
  });

  it("rejects a reversed date range", async () => {
    const { context } = await setup();
    await expect(
      call(context, "list_tasks", { due_after: "2026-03-31", due_before: "2026-03-01" }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("create_task", () => {
  it("posts the task and normalises the due date to a timestamp", async () => {
    const { context, fetchMock } = await setup();
    await call(context, "create_task", {
      title: "Buy milk",
      notes: "oat",
      due: "2026-05-04",
      tasklist_id: "l1",
    });

    const request = tasksApiCall(fetchMock);
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toContain("/lists/l1/tasks");
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      title: "Buy milk",
      notes: "oat",
      due: "2026-05-04T00:00:00.000Z",
    });
  });

  it("requires a non-empty title", async () => {
    const { context } = await setup();
    await expect(call(context, "create_task", {})).rejects.toBeInstanceOf(ToolExecutionError);
    await expect(call(context, "create_task", { title: "   " })).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("returns the created task with a date-only due field", async () => {
    const { context } = await setup();
    const output = await call(context, "create_task", { title: "T", due: "2026-05-04" });
    expect(output["task"]).toMatchObject({ id: "task-1", title: "T", due: "2026-05-04" });
  });
});

describe("update_task", () => {
  it("patches only the fields that were passed", async () => {
    const { context, fetchMock } = await setup();
    await call(context, "update_task", { task_id: "t1", notes: "new notes" });

    const request = tasksApiCall(fetchMock);
    expect(request.method).toBe("PATCH");
    expect(new URL(request.url).pathname).toContain("/tasks/t1");
    expect(JSON.parse(request.body ?? "{}")).toEqual({ notes: "new notes" });
  });

  it("refuses a patch with nothing in it", async () => {
    const { context } = await setup();
    await expect(call(context, "update_task", { task_id: "t1" })).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it("only accepts the two valid status values", async () => {
    const { context } = await setup();
    await expect(
      call(context, "update_task", { task_id: "t1", status: "done" }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("complete_task", () => {
  it("patches the status to completed", async () => {
    const { context, fetchMock } = await setup();
    await call(context, "complete_task", { task_id: "t1" });

    const request = tasksApiCall(fetchMock);
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body ?? "{}")).toEqual({ status: "completed" });
  });
});

describe("delete_task", () => {
  it("issues a DELETE and confirms the id it removed", async () => {
    const { context, fetchMock } = await setup();
    const output = await call(context, "delete_task", { task_id: "t1", tasklist_id: "l1" });

    const request = tasksApiCall(fetchMock);
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe("/tasks/v1/lists/l1/tasks/t1");
    expect(output).toEqual({ tasklist_id: "l1", deleted_task_id: "t1", deleted: true });
  });

  it("requires a task id", async () => {
    const { context } = await setup();
    await expect(call(context, "delete_task", {})).rejects.toBeInstanceOf(ToolExecutionError);
  });
});

describe("error mapping", () => {
  it("turns a Google 404 into an actionable message", async () => {
    const { context } = await setup({ status: 404 });
    const error = await call(context, "list_tasklists").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolExecutionError);
    expect((error as Error).message).toContain("Not found");
  });

  it("points at the disabled API on a 403", async () => {
    const { context } = await setup({ status: 403 });
    const error = await call(context, "list_tasklists").catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("Google Tasks API is enabled");
  });

  it("does not leak Google's status text for unexpected codes", async () => {
    const { context } = await setup({ status: 500 });
    const error = await call(context, "list_tasklists").catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      "The Google Tasks API returned an unexpected status (500).",
    );
  });

  it("rejects an unknown tool name", async () => {
    const { context } = await setup();
    await expect(call(context, "drop_database")).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("rejects non-object arguments", async () => {
    const { context } = await setup();
    await expect(call(context, "list_tasks", "oops")).rejects.toBeInstanceOf(ToolExecutionError);
  });
});
