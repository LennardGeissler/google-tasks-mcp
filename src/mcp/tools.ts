/**
 * Tool definitions.
 *
 * Six small tools with narrow inputs. The annotations are hints for the
 * client's UI and confirmation prompts: reads are marked readOnlyHint, the
 * one tool that destroys data is marked destructiveHint.
 */
import type { RateLimitBucket } from "../ratelimit.js";

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  /** Rate-limit buckets, most restrictive first. */
  buckets: readonly RateLimitBucket[];
}

const TASKLIST_ID = {
  type: "string",
  description:
    "Task list id from list_tasklists. Omit to use the account's default list.",
} as const;

const TASK_ID = {
  type: "string",
  description: "Task id, as returned by list_tasks.",
} as const;

const DUE = {
  type: "string",
  description:
    "Due date as YYYY-MM-DD. Google Tasks stores dates only — any time of day is ignored.",
} as const;

/** Reads: safe to call speculatively, never change anything. */
const READ_ONLY: ToolAnnotations = {
  title: "",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "list_tasklists",
    title: "List task lists",
    description:
      "List the Google Tasks lists in the account, with their ids and titles. " +
      "Call this first when the user names a list, to resolve it to an id.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { ...READ_ONLY, title: "List task lists" },
    buckets: ["all"],
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "List tasks in one task list. Open tasks only unless show_completed is true. " +
      "Use due_after / due_before to narrow to a date range.",
    inputSchema: {
      type: "object",
      properties: {
        tasklist_id: TASKLIST_ID,
        show_completed: {
          type: "boolean",
          description: "Include completed tasks as well. Defaults to false.",
        },
        due_after: {
          type: "string",
          description: "Only tasks due on or after this date (YYYY-MM-DD), inclusive.",
        },
        due_before: {
          type: "string",
          description: "Only tasks due on or before this date (YYYY-MM-DD), inclusive.",
        },
      },
      additionalProperties: false,
    },
    annotations: { ...READ_ONLY, title: "List tasks" },
    buckets: ["all"],
  },
  {
    name: "create_task",
    title: "Create task",
    description: "Create a task in a task list.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title. Required." },
        notes: { type: "string", description: "Optional free-text notes." },
        due: DUE,
        tasklist_id: TASKLIST_ID,
      },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: {
      title: "Create task",
      readOnlyHint: false,
      destructiveHint: false,
      // Calling it twice creates two tasks.
      idempotentHint: false,
      openWorldHint: true,
    },
    buckets: ["write", "all"],
  },
  {
    name: "update_task",
    title: "Update task",
    description:
      "Change fields of an existing task. Only the fields you pass are touched; " +
      "everything else keeps its current value.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: TASK_ID,
        tasklist_id: TASKLIST_ID,
        title: { type: "string", description: "New title." },
        notes: { type: "string", description: "New notes, replacing the previous ones." },
        due: DUE,
        status: {
          type: "string",
          enum: ["needsAction", "completed"],
          description:
            "Set to needsAction to reopen a completed task. Use complete_task to finish one.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Update task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    buckets: ["write", "all"],
  },
  {
    name: "complete_task",
    title: "Complete task",
    description: "Mark a task as done. Reopen it with update_task and status=needsAction.",
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID, tasklist_id: TASKLIST_ID },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Complete task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    buckets: ["write", "all"],
  },
  {
    name: "delete_task",
    title: "Delete task",
    description:
      "Permanently delete a task. This cannot be undone — prefer complete_task " +
      "unless the user explicitly asked for deletion.",
    inputSchema: {
      type: "object",
      properties: { task_id: TASK_ID, tasklist_id: TASKLIST_ID },
      required: ["task_id"],
      additionalProperties: false,
    },
    annotations: {
      title: "Delete task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    buckets: ["delete", "write", "all"],
  },
] as const;

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);

/** The wire shape of tools/list — annotations included, buckets stripped. */
export function toolListPayload(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}
