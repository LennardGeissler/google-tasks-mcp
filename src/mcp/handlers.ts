/**
 * Tool implementations.
 *
 * Every handler validates its own arguments and raises ToolExecutionError for
 * anything the model can fix by trying again with different input. Nothing in
 * here logs task titles, notes or ids.
 */
import type { Env } from "../env.js";
import { publicMessage, ToolExecutionError } from "../errors.js";
import { TasksClient, type Task } from "../google/tasks-client.js";
import { enforceRateLimit } from "../ratelimit.js";
import { TOOLS_BY_NAME } from "./tools.js";

/** Google's alias for the account's primary task list. */
const DEFAULT_TASKLIST = "@default";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ToolContext {
  env: Env;
  /** Session id from the access token; the rate-limit key. */
  sessionId: string;
}

// --- argument validation ---------------------------------------------------

function asRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new ToolExecutionError("Arguments must be a JSON object.");
  }
  return args as Record<string, unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolExecutionError(`Missing required string argument "${key}".`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolExecutionError(`Argument "${key}" must be a string.`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolExecutionError(`Argument "${key}" must be true or false.`);
  }
  return value;
}

function tasklistId(args: Record<string, unknown>): string {
  return optionalString(args, "tasklist_id") ?? DEFAULT_TASKLIST;
}

/**
 * Accept YYYY-MM-DD (and tolerate a full RFC 3339 timestamp by taking its
 * date part), then verify it is a real calendar date.
 */
export function normalizeDate(value: string, field: string): string {
  const candidate = value.length > 10 && value[10] === "T" ? value.slice(0, 10) : value;
  const match = DATE_ONLY.exec(candidate);
  if (match === null) {
    throw new ToolExecutionError(`Argument "${field}" must be a date in YYYY-MM-DD form.`);
  }
  const [, year, month, day] = match;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new ToolExecutionError(`Argument "${field}" is not a valid calendar date.`);
  }
  return candidate;
}

/** Google Tasks keeps only the date part, but wants a full timestamp. */
function startOfDay(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`;
}

// --- output shaping --------------------------------------------------------

interface TaskView {
  id: string;
  title: string;
  status: "needsAction" | "completed";
  due?: string;
  notes?: string;
  completed?: string;
}

function toView(task: Task): TaskView {
  const view: TaskView = {
    id: task.id,
    title: task.title ?? "",
    status: task.status,
  };
  if (task.due !== undefined) view.due = task.due.slice(0, 10);
  if (task.notes !== undefined) view.notes = task.notes;
  if (task.completed !== undefined) view.completed = task.completed.slice(0, 10);
  return view;
}

/** Structured payload plus the same JSON as text, as the tools spec advises. */
function result(structured: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

// --- dispatch --------------------------------------------------------------

export async function callTool(
  context: ToolContext,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult> {
  const definition = TOOLS_BY_NAME.get(name);
  if (definition === undefined) {
    throw new ToolExecutionError(`Unknown tool "${name}".`);
  }

  await enforceRateLimit(context.env, context.sessionId, definition.buckets);

  const args = asRecord(rawArgs);
  const client = new TasksClient(context.env);

  switch (name) {
    case "list_tasklists":
      return listTaskLists(client);
    case "list_tasks":
      return listTasks(client, args);
    case "create_task":
      return createTask(client, args);
    case "update_task":
      return updateTask(client, args);
    case "complete_task":
      return completeTask(client, args);
    case "delete_task":
      return deleteTask(client, args);
    default:
      throw new ToolExecutionError(`Unknown tool "${name}".`);
  }
}

async function listTaskLists(client: TasksClient): Promise<ToolResult> {
  const lists = await client.listTaskLists();
  return result({
    tasklists: lists.map((list) => ({ id: list.id, title: list.title })),
  });
}

async function listTasks(
  client: TasksClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const listId = tasklistId(args);
  const showCompleted = optionalBoolean(args, "show_completed") ?? false;

  const rawAfter = optionalString(args, "due_after");
  const rawBefore = optionalString(args, "due_before");
  const dueAfter = rawAfter === undefined ? undefined : normalizeDate(rawAfter, "due_after");
  const dueBefore = rawBefore === undefined ? undefined : normalizeDate(rawBefore, "due_before");

  if (dueAfter !== undefined && dueBefore !== undefined && dueAfter > dueBefore) {
    throw new ToolExecutionError("due_after must not be later than due_before.");
  }

  const options: Parameters<TasksClient["listTasks"]>[0] = {
    tasklistId: listId,
    showCompleted,
  };
  if (dueAfter !== undefined) options.dueMin = startOfDay(dueAfter);
  if (dueBefore !== undefined) options.dueMax = endOfDay(dueBefore);

  const { tasks, truncated } = await client.listTasks(options);

  // Google's dueMin/dueMax filtering is unreliable when combined with
  // showCompleted, so the range is enforced here as well.
  const filtered = tasks.filter((task) => {
    if (dueAfter === undefined && dueBefore === undefined) return true;
    if (task.due === undefined) return false;
    const due = task.due.slice(0, 10);
    if (dueAfter !== undefined && due < dueAfter) return false;
    if (dueBefore !== undefined && due > dueBefore) return false;
    return true;
  });

  return result({
    tasklist_id: listId,
    count: filtered.length,
    truncated,
    tasks: filtered.map(toView),
  });
}

async function createTask(
  client: TasksClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const listId = tasklistId(args);
  const body: { title: string; notes?: string; due?: string } = {
    title: requiredString(args, "title"),
  };

  const notes = optionalString(args, "notes");
  if (notes !== undefined) body.notes = notes;

  const due = optionalString(args, "due");
  if (due !== undefined) body.due = startOfDay(normalizeDate(due, "due"));

  const created = await client.createTask(listId, body);
  return result({ tasklist_id: listId, task: toView(created) });
}

async function updateTask(
  client: TasksClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const listId = tasklistId(args);
  const taskId = requiredString(args, "task_id");

  const patch: { title?: string; notes?: string; due?: string; status?: Task["status"] } = {};
  const title = optionalString(args, "title");
  if (title !== undefined) patch.title = title;

  const notes = optionalString(args, "notes");
  if (notes !== undefined) patch.notes = notes;

  const due = optionalString(args, "due");
  if (due !== undefined) patch.due = startOfDay(normalizeDate(due, "due"));

  const status = optionalString(args, "status");
  if (status !== undefined) {
    if (status !== "needsAction" && status !== "completed") {
      throw new ToolExecutionError('Argument "status" must be "needsAction" or "completed".');
    }
    patch.status = status;
  }

  if (Object.keys(patch).length === 0) {
    throw new ToolExecutionError(
      "Nothing to update — pass at least one of title, notes, due or status.",
    );
  }

  const updated = await client.patchTask(listId, taskId, patch);
  return result({ tasklist_id: listId, task: toView(updated) });
}

async function completeTask(
  client: TasksClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const listId = tasklistId(args);
  const taskId = requiredString(args, "task_id");
  const updated = await client.patchTask(listId, taskId, { status: "completed" });
  return result({ tasklist_id: listId, task: toView(updated) });
}

async function deleteTask(
  client: TasksClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const listId = tasklistId(args);
  const taskId = requiredString(args, "task_id");
  await client.deleteTask(listId, taskId);
  return result({ tasklist_id: listId, deleted_task_id: taskId, deleted: true });
}

/**
 * Convert a thrown error into a tool result the model can recover from.
 * Anything unexpected collapses to a fixed message — no stack traces.
 */
export function toErrorResult(error: unknown): ToolResult {
  return { content: [{ type: "text", text: publicMessage(error) }], isError: true };
}
